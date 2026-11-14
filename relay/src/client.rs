//! Client connections for a computer's names: passed through to the computer still encrypted.

use crate::id::random_b64url;
use crate::state::{Level, Out, State, frame};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::oneshot;

const DATA_DEADLINE: Duration = Duration::from_secs(10);
const SLOW_CONN_DELAY: Duration = Duration::from_secs(1);

pub async fn run(
    state: Arc<State>,
    client: TcpStream,
    peer: SocketAddr,
    hello: Vec<u8>,
    id: String,
) {
    if state.is_blocked(&id) {
        return;
    }
    let Some(agent) = state.agent(&id) else {
        tracing::debug!(id, peer = %peer.ip(), "client for a computer that is not connected");
        return;
    };
    let Some(_slot) = state.client_slot() else {
        tracing::warn!(id, peer = %peer.ip(), "client refused: relay at --max-connections");
        return;
    };
    match state.count_conn(&id) {
        Level::Over => {
            state.cut(&id, "over-limit", "Too many new connections this minute.");
            return;
        }
        Level::Slow => tokio::time::sleep(SLOW_CONN_DELAY).await,
        Level::Ok => {}
    }

    let conn = random_b64url::<16>();
    let (tx, rx) = oneshot::channel();
    state.add_pending(&conn, tx);
    let open = json!({"t": "open", "conn": conn, "peer": peer.ip().to_string()});
    let _ = agent.tx.send(Out::Frame(frame(open)));
    let mut data = match tokio::time::timeout(DATA_DEADLINE, rx).await {
        Ok(Ok(data)) => data,
        _ => {
            state.take_pending(&conn);
            tracing::info!(id, peer = %peer.ip(), "client closed: computer did not open a data connection in 10 s");
            return;
        }
    };
    if data.write_all(&hello).await.is_err() {
        return;
    }

    let started = Instant::now();
    let up = AtomicU64::new(hello.len() as u64);
    let down = AtomicU64::new(0);
    let last = AtomicU64::new(0);
    let idle = Duration::from_secs(state.cfg.idle_timeout_secs);
    let (cr, cw) = client.into_split();
    let (dr, dw) = tokio::io::split(data);
    let reason = tokio::select! {
        _ = async {
            tokio::join!(
                copy(&state, &id, cr, dw, &up, &last, started),
                copy(&state, &id, dr, cw, &down, &last, started),
            )
        } => "closed",
        _ = watch_idle(&last, started, idle) => "idle",
        _ = agent.cut.cancelled() => "cut off",
    };
    tracing::info!(
        id,
        peer = %peer.ip(),
        up = up.load(Ordering::Relaxed),
        down = down.load(Ordering::Relaxed),
        ms = started.elapsed().as_millis() as u64,
        reason,
        "client connection ended"
    );
}

async fn copy<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    state: &State,
    id: &str,
    mut r: R,
    mut w: W,
    count: &AtomicU64,
    last: &AtomicU64,
    started: Instant,
) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        last.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
        count.fetch_add(n as u64, Ordering::Relaxed);
        match state.count_bytes(id, n as u64) {
            Level::Over => {
                state.cut(id, "over-limit", "Too much traffic this minute.");
                break;
            }
            Level::Slow => tokio::time::sleep(state.slow_delay(n as u64)).await,
            Level::Ok => {}
        }
        if w.write_all(&buf[..n]).await.is_err() {
            break;
        }
    }
    let _ = w.shutdown().await;
}

async fn watch_idle(last: &AtomicU64, started: Instant, idle: Duration) {
    loop {
        let last_ms = last.load(Ordering::Relaxed);
        let deadline = started + Duration::from_millis(last_ms) + idle;
        if Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep_until(deadline.into()).await;
    }
}
