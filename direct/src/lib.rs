//! `pane-direct`: carries a Pane computer's TLS byte stream over an iroh QUIC
//! connection. The `pane-direct` binary runs it as a helper process (see
//! README.md); the Pane app runs `connect` in-process through [`ffi`].

pub mod connect;
pub mod ffi;
pub mod pinned_tls;
pub mod serve;

#[cfg(target_os = "android")]
mod android;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use iroh::{
    Endpoint, RelayMode, RelayUrl, SecretKey,
    endpoint::{RecvStream, SendStream, presets},
    tls::CaTlsConfig,
};
use rustls::pki_types::{CertificateDer, pem::PemObject};
use serde_json::{Value, json};
use tokio::{io::AsyncWriteExt, net::TcpStream};

pub const ALPN: &[u8] = b"pane/direct/1";

/// Receives each event (`ready`, `path`, `peer`, `addrs`, `error`) as one JSON value.
pub type Emit = Arc<dyn Fn(Value) + Send + Sync>;

pub fn emit_error(emit: &Emit, message: impl std::fmt::Display) {
    emit(json!({ "t": "error", "message": message.to_string() }));
}

/// The relays an endpoint may use, and extra roots trusted for their certificates.
pub struct Relays {
    pub urls: Vec<RelayUrl>,
    /// A PEM file of extra CA certificates (a test relay's own CA).
    pub ca: Option<PathBuf>,
}

pub async fn bind_endpoint(
    secret_key: Option<SecretKey>,
    alpns: Vec<Vec<u8>>,
    bind: Option<SocketAddr>,
    relays: &Relays,
) -> Result<Endpoint, String> {
    // Builder::new starts with no address lookup and relays disabled; relays
    // are only the ones Pane names, never n0's public defaults.
    let mut builder = Endpoint::builder(presets::Minimal).alpns(alpns);
    if !relays.urls.is_empty() {
        builder = builder.relay_mode(RelayMode::custom(relays.urls.iter().cloned()));
    }
    if let Some(path) = &relays.ca {
        let roots = CertificateDer::pem_file_iter(path)
            .and_then(|certs| certs.collect::<Result<Vec<_>, _>>())
            .map_err(|e| format!("--relay-ca {}: {e}", path.display()))?;
        builder = builder.ca_tls_config(CaTlsConfig::default().with_extra_roots(roots));
    }
    if let Some(key) = secret_key {
        builder = builder.secret_key(key);
    }
    if let Some(addr) = bind {
        builder = builder
            .clear_ip_transports()
            .bind_addr(addr)
            .map_err(|e| format!("--bind {addr}: {e}"))?;
    }
    builder
        .bind()
        .await
        .map_err(|e| format!("bind failed: {e}"))
}

/// Pipes a TCP connection and a QUIC bidirectional stream both ways, passing
/// half-closes through. Any error resets the QUIC stream and drops the socket.
pub async fn pipe(tcp: TcpStream, mut send: SendStream, mut recv: RecvStream) {
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let up = async {
        tokio::io::copy(&mut tcp_read, &mut send).await?;
        send.finish().map_err(std::io::Error::other)
    };
    let down = async {
        tokio::io::copy(&mut recv, &mut tcp_write).await?;
        tcp_write.shutdown().await
    };
    if tokio::try_join!(up, down).is_err() {
        send.reset(0u32.into()).ok();
        recv.stop(0u32.into()).ok();
    }
}
