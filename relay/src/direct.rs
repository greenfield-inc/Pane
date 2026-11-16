//! The iroh relay for direct paths (PROTOCOL.md "Direct paths"). An iroh relay
//! server runs in process on loopback; the https listener passes its paths to it.

use crate::Error;
use crate::io::BoxStream;
use crate::state::{Charge, Level, State, source};
use iroh_relay::server::{QuicConfig, RelayConfig, Server, ServerConfig};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// The iroh relay's websocket path and its latency probe.
pub const PATHS: [&str; 2] = ["/relay", "/ping"];

const SLOW_CONN_DELAY: Duration = Duration::from_secs(1);

/// Starts the iroh relay on a loopback port, plus QUIC address discovery on
/// `quic` when given (with the relay's own certificate).
pub async fn spawn(quic: Option<SocketAddr>, tls: &rustls::ServerConfig) -> Result<Server, Error> {
    let mut cfg = ServerConfig::default();
    cfg.relay = Some(RelayConfig::new((Ipv4Addr::LOCALHOST, 0)));
    cfg.quic = quic.map(|addr| {
        let mut q = QuicConfig::new(addr);
        q.server_config = Some(tls.clone());
        q
    });
    Ok(Server::spawn(cfg).await?)
}

/// Passes one decrypted https connection to the iroh relay, starting with the
/// request head already read. Limits apply per client IP address.
pub async fn proxy(state: Arc<State>, client: BoxStream, head: Vec<u8>, peer: IpAddr) {
    let Some(_slot) = state.client_slot() else {
        tracing::warn!(%peer, "direct relay client refused: relay at --max-connections");
        return;
    };
    let key = source(peer);
    match state.charge(Charge::Direct(&key), 0, 1) {
        Level::Over => return,
        Level::Slow => tokio::time::sleep(SLOW_CONN_DELAY).await,
        Level::Ok => {}
    }
    let Ok(mut server) = TcpStream::connect(state.direct_addr).await else {
        return;
    };
    if server.write_all(&head).await.is_err() {
        return;
    }
    let over = CancellationToken::new();
    let (cr, cw) = tokio::io::split(client);
    let (sr, sw) = server.into_split();
    tokio::select! {
        _ = async {
            tokio::join!(
                copy(&state, &key, cr, sw, &over),
                copy(&state, &key, sr, cw, &over),
            )
        } => {}
        _ = over.cancelled() => tracing::info!(%peer, "direct relay client cut off: over the limit"),
        _ = state.shutdown.cancelled() => {}
    }
}

async fn copy<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    state: &State,
    key: &str,
    mut r: R,
    mut w: W,
    over: &CancellationToken,
) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        match state.charge(Charge::Direct(key), n as u64, 0) {
            Level::Over => {
                over.cancel();
                return;
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
