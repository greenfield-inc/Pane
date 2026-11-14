//! C ABI for the Pane app: runs `connect` in-process with TLS to the
//! computer's name and its pinned key. Swift calls these directly; Android
//! reaches them through `android.rs`.
//!
//! Strings in and out are UTF-8 JSON. Every string this returns is freed with
//! [`pane_direct_free_string`].

use std::{
    collections::HashMap,
    ffi::{CStr, CString, c_char},
    net::SocketAddr,
    panic::catch_unwind,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, RecvTimeoutError, channel},
    },
    time::Duration,
};

use iroh::{Endpoint, EndpointId, RelayUrl};
use serde_json::{Value, json};
use tokio::{net::TcpListener, runtime::Runtime, task::JoinHandle};

use crate::{Emit, bind_endpoint, connect, emit_error, pinned_tls::PinnedTls};

static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("pane-direct")
        .enable_all()
        .build()
        .expect("tokio runtime")
});

struct Session {
    endpoint: Endpoint,
    task: JoinHandle<()>,
    events: Arc<Mutex<Receiver<Value>>>,
}

static SESSIONS: LazyLock<Mutex<HashMap<u64, Session>>> = LazyLock::new(Default::default);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// What `pane_direct_connect` takes.
struct Config {
    node_id: EndpointId,
    relay_urls: Vec<RelayUrl>,
    direct_addrs: Vec<SocketAddr>,
    tls: PinnedTls,
}

fn parse_config(text: &str) -> Result<Config, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("config: {e}"))?;
    let str_field = |name: &str| {
        value[name]
            .as_str()
            .ok_or_else(|| format!("config needs {name}"))
    };
    let list = |name: &str| -> Vec<String> {
        value[name]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    };
    Ok(Config {
        node_id: str_field("nodeId")?
            .parse()
            .map_err(|e| format!("nodeId: {e}"))?,
        relay_urls: list("relayUrls")
            .iter()
            .map(|u| u.parse().map_err(|e| format!("relayUrls {u}: {e}")))
            .collect::<Result<_, String>>()?,
        // An address this phone can't use (another family, a typo) is skipped, not fatal.
        direct_addrs: list("directAddrs")
            .iter()
            .filter_map(|a| a.parse().ok())
            .collect(),
        tls: PinnedTls::new(str_field("serverName")?, str_field("fingerprint")?)?,
    })
}

/// Starts a connection. Returns `{"id": n, "port": p}` (requests sent as
/// plain HTTP to `127.0.0.1:p` reach the computer over TLS) or `{"error"}`.
///
/// `config`: `{nodeId, relayUrls: [url], directAddrs: ["ip:port"], serverName, fingerprint}`.
///
/// # Safety
/// `config` is a valid NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pane_direct_connect(config: *const c_char) -> *mut c_char {
    let text = unsafe { CStr::from_ptr(config) }
        .to_string_lossy()
        .into_owned();
    let result = catch_unwind(|| start(&text)).unwrap_or_else(|_| Err("panicked".into()));
    to_c(match result {
        Ok((id, port)) => json!({ "id": id, "port": port }),
        Err(message) => json!({ "error": message }),
    })
}

/// Waits up to `timeout_ms` for the connection's next event: `{"t":"path",
/// "path":"direct"|"relay","rttMs"}` or `{"t":"error","message"}`. Returns null
/// on timeout, and `{"t":"closed"}` once the connection is closed.
#[unsafe(no_mangle)]
pub extern "C" fn pane_direct_next_event(id: u64, timeout_ms: u32) -> *mut c_char {
    let Some(events) = SESSIONS.lock().unwrap().get(&id).map(|s| s.events.clone()) else {
        return to_c(json!({ "t": "closed" }));
    };
    let events = events.lock().unwrap();
    match events.recv_timeout(Duration::from_millis(timeout_ms.into())) {
        Ok(event) => to_c(event),
        Err(RecvTimeoutError::Timeout) => std::ptr::null_mut(),
        Err(RecvTimeoutError::Disconnected) => to_c(json!({ "t": "closed" })),
    }
}

/// Stops a connection and frees its port. Unknown ids are ignored.
#[unsafe(no_mangle)]
pub extern "C" fn pane_direct_close(id: u64) {
    let Some(session) = SESSIONS.lock().unwrap().remove(&id) else {
        return;
    };
    session.task.abort();
    RUNTIME.spawn(async move {
        tokio::time::timeout(Duration::from_secs(2), session.endpoint.close())
            .await
            .ok();
    });
}

/// # Safety
/// `text` came from this library and is freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn pane_direct_free_string(text: *mut c_char) {
    if !text.is_null() {
        drop(unsafe { CString::from_raw(text) });
    }
}

fn start(text: &str) -> Result<(u64, u16), String> {
    let config = parse_config(text)?;
    let (tx, rx) = channel();
    let tx = Mutex::new(tx);
    let emit: Emit = Arc::new(move |event| {
        tx.lock().unwrap().send(event).ok();
    });
    let (endpoint, listener) = RUNTIME.block_on(async {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("listen: {e}"))?;
        let endpoint = bind_endpoint(None, Vec::new(), None, &config.relay_urls).await?;
        Ok::<_, String>((endpoint, listener))
    })?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let run = connect::run(
        endpoint.clone(),
        config.node_id,
        config.direct_addrs,
        config.relay_urls,
        listener,
        Some(config.tls),
        emit.clone(),
    );
    let task = RUNTIME.spawn(async move {
        if let Err(message) = run.await {
            emit_error(&emit, message);
        }
    });
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    SESSIONS.lock().unwrap().insert(
        id,
        Session {
            endpoint,
            task,
            events: Arc::new(Mutex::new(rx)),
        },
    );
    Ok((id, port))
}

fn to_c(value: Value) -> *mut c_char {
    // JSON text never holds a NUL byte.
    CString::new(value.to_string()).unwrap().into_raw()
}
