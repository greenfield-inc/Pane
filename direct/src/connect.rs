//! Client side: a local TCP listener whose connections each become a
//! bidirectional stream on one shared QUIC connection to the computer.

use std::{net::SocketAddr, time::Duration};

use iroh::{Endpoint, EndpointAddr, EndpointId, RelayUrl, endpoint::Connection};
use n0_future::StreamExt;
use serde_json::json;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::watch,
    time::{Instant, sleep, timeout},
};

use crate::{ALPN, emit, emit_error, pipe, serve::selected_path};

const MAX_BACKOFF: Duration = Duration::from_secs(30);
const DIAL_TIMEOUT: Duration = Duration::from_secs(15);
/// How long a local connection waits for the QUIC connection to come up.
const STREAM_WAIT: Duration = Duration::from_secs(30);
const RTT_CHECK: Duration = Duration::from_secs(2);

pub async fn run(
    endpoint: Endpoint,
    node_id: EndpointId,
    direct_addrs: Vec<SocketAddr>,
    relay_urls: Vec<RelayUrl>,
    listen: SocketAddr,
) -> Result<(), String> {
    let listener = TcpListener::bind(listen)
        .await
        .map_err(|e| format!("--listen {listen}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let mut addr = EndpointAddr::new(node_id);
    for a in direct_addrs {
        addr = addr.with_ip_addr(a);
    }
    for url in relay_urls {
        addr = addr.with_relay_url(url);
    }
    let (conn_tx, conn_rx) = watch::channel::<Option<Connection>>(None);
    tokio::spawn(keep_connected(endpoint, addr, conn_tx));

    emit(json!({ "t": "ready", "port": port }));
    loop {
        let (tcp, _) = listener.accept().await.map_err(|e| e.to_string())?;
        tokio::spawn(forward(tcp, conn_rx.clone()));
    }
}

async fn forward(tcp: TcpStream, mut conn_rx: watch::Receiver<Option<Connection>>) {
    let live = |c: &Option<Connection>| c.as_ref().is_some_and(|c| c.close_reason().is_none());
    let wait = async { conn_rx.wait_for(live).await.ok().and_then(|c| c.clone()) };
    let Ok(Some(conn)) = timeout(STREAM_WAIT, wait).await else {
        return;
    };
    if let Ok((send, recv)) = conn.open_bi().await {
        tcp.set_nodelay(true).ok();
        pipe(tcp, send, recv).await;
    }
}

/// Holds one connection to the computer open, redialing with backoff, for as
/// long as the process runs.
async fn keep_connected(
    endpoint: Endpoint,
    addr: EndpointAddr,
    conn_tx: watch::Sender<Option<Connection>>,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match timeout(DIAL_TIMEOUT, endpoint.connect(addr.clone(), ALPN)).await {
            Ok(Ok(conn)) => {
                let started = Instant::now();
                conn_tx.send_replace(Some(conn.clone()));
                let reason = report_paths(&conn).await;
                conn_tx.send_replace(None);
                emit_error(format!("connection lost: {reason}"));
                if started.elapsed() > MAX_BACKOFF {
                    backoff = Duration::from_secs(1);
                }
            }
            Ok(Err(e)) => emit_error(format!("connect failed: {e}")),
            Err(_) => emit_error("connect timed out"),
        }
        sleep(backoff).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

/// Emits `path` events until the connection closes, then returns why it did.
async fn report_paths(conn: &Connection) -> String {
    let mut last: Option<(&str, Duration)> = None;
    let mut snapshots = conn.paths_stream();
    let mut tick = tokio::time::interval(RTT_CHECK);
    loop {
        tokio::select! {
            err = conn.closed() => return err.to_string(),
            snapshot = snapshots.next() => if snapshot.is_none() {
                return conn.closed().await.to_string();
            },
            _ = tick.tick() => {}
        }
        let Some((kind, rtt)) = selected_path(&conn.paths()) else {
            continue;
        };
        if last.is_none_or(|(last_kind, last_rtt)| kind != last_kind || rtt_changed(last_rtt, rtt))
        {
            last = Some((kind, rtt));
            emit(json!({ "t": "path", "path": kind, "rttMs": rtt.as_millis() as u64 }));
        }
    }
}

/// An RTT change worth reporting: at least 5 ms and at least 25%.
fn rtt_changed(old: Duration, new: Duration) -> bool {
    let diff = old.abs_diff(new);
    diff >= Duration::from_millis(5) && diff * 4 >= old
}
