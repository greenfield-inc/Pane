//! Pane relay: routes TLS by SNI to connected Pane computers (see PROTOCOL.md).

mod acme;
mod agent;
mod alerts;
mod api;
mod client;
pub mod config;
mod direct;
mod dns;
pub mod id;
mod io;
mod registry;
mod sni;
mod state;
mod tls;

pub use config::Config;

use crate::io::{BoxStream, Prefixed};
use crate::sni::{Hello, parse_client_hello};
use crate::state::State;
use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub type Error = Box<dyn std::error::Error + Send + Sync>;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_HELLO: usize = 32 * 1024;
const BLOCKLIST_POLL: Duration = Duration::from_secs(5);

/// A running relay.
pub struct Relay {
    pub https_addr: SocketAddr,
    pub dns_addr: Option<SocketAddr>,
    /// The QUIC address discovery socket, with --direct-quic.
    pub direct_quic_addr: Option<SocketAddr>,
    /// The self-signed certificate's PEM file in --dev mode.
    pub dev_cert: Option<PathBuf>,
    shutdown: CancellationToken,
    task: JoinHandle<()>,
    direct: iroh_relay::server::Server,
}

impl Relay {
    /// Stops accepting, sends `close shutdown` to computers, and waits up to 3 s for them.
    pub async fn shutdown(self) {
        self.shutdown.cancel();
        let _ = self.task.await;
        let _ = self.direct.shutdown().await;
    }
}

/// Binds the listeners and starts serving.
pub async fn start(cfg: Config) -> Result<Relay, Error> {
    let domain = cfg.domain()?;
    let mut acme = None;
    let (tls, cert, dev_cert) = match (&cfg.cert, &cfg.key, &cfg.acme_cache, cfg.dev) {
        (Some(c), Some(k), _, _) => {
            let (tls, cert) = tls::load(c, k)?;
            (tls, cert, None)
        }
        (None, None, Some(cache), _) => {
            let region = cfg.region.to_ascii_lowercase();
            let a = acme::Acme {
                cache: cache.clone(),
                directory: cfg.acme_directory.clone(),
                email: cfg.acme_email.clone(),
                ca: cfg.provider_ca.clone(),
                names: vec![domain.clone(), format!("{region}.relay.{domain}")],
            };
            let (tls, cert) = tls::server_config(a.initial()?)?;
            acme = Some(a);
            (tls, cert, None)
        }
        (None, None, None, true) => {
            let (tls, cert, path) = tls::dev(&domain)?;
            (tls, cert, Some(path))
        }
        _ => {
            return Err(
                "pass --cert and --key, --acme-cache for an ACME certificate, or --dev for a self-signed one"
                    .into(),
            );
        }
    };
    let registry = registry::Registry::new(
        &cfg.registry_url,
        cfg.registry_secret.clone(),
        cfg.provider_ca.as_deref(),
    )?;
    let listener = TcpListener::bind(cfg.listen_addr()).await?;
    let https_addr = listener.local_addr()?;
    let dns_sockets = match cfg.dns {
        Some(addr) => {
            let udp = UdpSocket::bind(addr).await?;
            let addr = udp.local_addr()?;
            let tcp = TcpListener::bind(addr).await?;
            Some((udp, tcp))
        }
        None => None,
    };
    let dns_addr = dns_sockets
        .as_ref()
        .map(|(u, _)| u.local_addr())
        .transpose()?;
    let blocklist = cfg.blocklist.clone();
    let alerts = alerts::Alerts::load(&cfg)?;
    let direct = direct::spawn(cfg.direct_quic, &tls).await?;
    let direct_addr = direct.http_addr().ok_or("iroh relay has no address")?;
    let direct_quic_addr = direct.quic_addr();
    let state = Arc::new(State::new(
        cfg,
        domain,
        registry,
        alerts,
        direct_addr,
        https_addr.port(),
    ));
    let mut blocklist_mtime = None;
    if let Some(path) = &blocklist {
        reload_blocklist(&state, path, &mut blocklist_mtime).await;
    }

    if let Some((udp, tcp)) = dns_sockets {
        tokio::spawn(dns::serve_udp(state.clone(), udp));
        tokio::spawn(dns::serve_tcp(state.clone(), tcp));
    }
    tokio::spawn(maintenance(state.clone(), blocklist, blocklist_mtime));
    tokio::spawn(resync(state.clone()));
    if let Some(a) = acme {
        tokio::spawn(acme::run(state.clone(), cert, a));
    }

    let shutdown = state.shutdown.clone();
    let task = tokio::spawn(async move {
        loop {
            let (tcp, peer) = tokio::select! {
                _ = state.shutdown.cancelled() => break,
                r = listener.accept() => match r {
                    Ok(r) => r,
                    Err(e) => {
                        tracing::warn!(error = %e, "accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                },
            };
            state
                .tracker
                .spawn(connection(state.clone(), tls.clone(), tcp, peer));
        }
        state.tracker.close();
        let _ = tokio::time::timeout(Duration::from_secs(3), state.tracker.wait()).await;
    });
    tracing::info!(%https_addr, ?dns_addr, ?direct_quic_addr, "relay listening");
    Ok(Relay {
        https_addr,
        dns_addr,
        direct_quic_addr,
        dev_cert,
        shutdown,
        task,
        direct,
    })
}

enum Route {
    Own,
    Computer(String),
}

fn route(domain: &str, sni: Option<&str>) -> Option<Route> {
    let Some(name) = sni else {
        return Some(Route::Own);
    };
    if name == domain {
        return Some(Route::Own);
    }
    let prefix = name.strip_suffix(domain)?.strip_suffix('.')?;
    let mut labels = prefix.rsplit('.');
    let last = labels.next()?;
    if last == "relay" {
        return Some(Route::Own);
    }
    id::is_valid_id(last).then(|| Route::Computer(last.to_string()))
}

async fn connection(
    state: Arc<State>,
    tls: Arc<rustls::ServerConfig>,
    mut tcp: TcpStream,
    peer: SocketAddr,
) {
    // A dual-stack listener reports IPv4 clients as ::ffff:a.b.c.d.
    let peer = SocketAddr::new(peer.ip().to_canonical(), peer.port());
    let mut buf = Vec::with_capacity(2048);
    let read_hello = async {
        let mut chunk = [0u8; 4096];
        loop {
            match parse_client_hello(&buf) {
                Hello::Complete(sni) => return Some(sni),
                Hello::Invalid => return None,
                Hello::Incomplete if buf.len() > MAX_HELLO => return None,
                Hello::Incomplete => {}
            }
            match tcp.read(&mut chunk).await {
                Ok(0) | Err(_) => return None,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    };
    let Ok(Some(sni)) = tokio::time::timeout(HELLO_TIMEOUT, read_hello).await else {
        return;
    };
    match route(&state.domain, sni.as_deref()) {
        Some(Route::Own) => {
            let acceptor = tokio_rustls::TlsAcceptor::from(tls);
            let accept = acceptor.accept(Prefixed::new(buf, tcp));
            if let Ok(Ok(stream)) = tokio::time::timeout(HELLO_TIMEOUT, accept).await {
                let stream: BoxStream = Box::new(stream);
                api::serve(state, stream, peer.ip()).await;
            }
        }
        Some(Route::Computer(id)) => client::run(state, tcp, peer, buf, id).await,
        None => {}
    }
}

async fn reload_blocklist(state: &State, path: &PathBuf, last: &mut Option<SystemTime>) {
    let mtime = tokio::fs::metadata(path)
        .await
        .and_then(|m| m.modified())
        .ok();
    if mtime == *last {
        return;
    }
    *last = mtime;
    let text = tokio::fs::read_to_string(path).await.unwrap_or_default();
    let ids: HashSet<String> = text
        .lines()
        .map(|l| l.trim().to_ascii_lowercase())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    tracing::info!(count = ids.len(), "blocklist loaded");
    state.set_blocklist(ids);
}

async fn maintenance(state: Arc<State>, blocklist: Option<PathBuf>, mut mtime: Option<SystemTime>) {
    let mut tick = tokio::time::interval(BLOCKLIST_POLL);
    loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => return,
            _ = tick.tick() => {}
        }
        if let Some(path) = &blocklist {
            reload_blocklist(&state, path, &mut mtime).await;
        }
        state.prune_usage();
        state.alerts.prune();
    }
}

/// Re-queues connected computers for every helper, so a restarted helper relearns them.
/// It only queues: each helper's own task sends, so a slow helper delays nothing here.
async fn resync(state: Arc<State>) {
    let period = Duration::from_secs(state.cfg.registry_resync_secs.max(1));
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => return,
            _ = tick.tick() => state.registry.resync(&state.connected_ids()),
        }
    }
}
