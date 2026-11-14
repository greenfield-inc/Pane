use clap::Parser;
use pane_relay::Config;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().with_target(false).init();
    let cfg = Config::parse();
    let relay = match pane_relay::start(cfg).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("pane-relay: {e}");
            std::process::exit(1);
        }
    };
    if let Some(path) = &relay.dev_cert {
        tracing::info!(cert = %path.display(), "dev mode: self-signed certificate written here; trust it in local agents");
    }
    wait_for_signal().await;
    tracing::info!("shutting down");
    relay.shutdown().await;
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
