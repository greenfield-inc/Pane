//! `pane-direct`: carries a Pane computer's TLS byte stream over an iroh QUIC
//! connection. See README.md for the stdin/stdout protocol.

use std::{
    future::Future, net::SocketAddr, path::PathBuf, pin::Pin, process::ExitCode, sync::Arc,
    time::Duration,
};

use iroh::{EndpointId, SecretKey};
use pane_direct::{ALPN, Emit, Relays, bind_endpoint, connect, serve};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpListener,
};

type RunFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

const USAGE: &str = "usage:
  pane-direct serve --secret-key-file <path> --target <ip:port> [--bind <ip:port>] [--relay-url <url>]... [--relay-ca <pem>]
  pane-direct connect --node-id <id> [--relay-url <url>]... [--relay-ca <pem>] [--direct-addr <ip:port>]... [--listen <ip:port>]";

/// Writes one JSON line to stdout. `println!` locks stdout per call, so lines
/// from concurrent tasks never interleave.
fn emit(event: Value) {
    println!("{event}");
}

fn emit_error(message: impl std::fmt::Display) {
    emit(json!({ "t": "error", "message": message.to_string() }));
}

enum Mode {
    Serve {
        secret_key_file: PathBuf,
        target: SocketAddr,
        bind: Option<SocketAddr>,
    },
    Connect {
        node_id: EndpointId,
        direct_addrs: Vec<SocketAddr>,
        listen: SocketAddr,
    },
}

struct Args {
    mode: Mode,
    relays: Relays,
}

fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<Args, String> {
    let command = argv.next().ok_or("missing command")?;
    let mut flags: Vec<(String, String)> = Vec::new();
    while let Some(flag) = argv.next() {
        let value = argv.next().ok_or_else(|| format!("{flag} needs a value"))?;
        flags.push((flag, value));
    }
    let mut relay_urls = Vec::new();
    let mut relay_ca = None;
    let mut secret_key_file = None;
    let mut target = None;
    let mut bind = None;
    let mut node_id = None;
    let mut direct_addrs = Vec::new();
    let mut listen = SocketAddr::from(([127, 0, 0, 1], 0));
    let bad = |flag: &str, err: &dyn std::fmt::Display| format!("{flag}: {err}");
    for (flag, value) in &flags {
        match (command.as_str(), flag.as_str()) {
            (_, "--relay-url") => relay_urls.push(value.parse().map_err(|e| bad(flag, &e))?),
            (_, "--relay-ca") => relay_ca = Some(PathBuf::from(value)),
            ("serve", "--secret-key-file") => secret_key_file = Some(PathBuf::from(value)),
            ("serve", "--target") => target = Some(value.parse().map_err(|e| bad(flag, &e))?),
            ("serve", "--bind") => bind = Some(value.parse().map_err(|e| bad(flag, &e))?),
            ("connect", "--node-id") => node_id = Some(value.parse().map_err(|e| bad(flag, &e))?),
            ("connect", "--direct-addr") => {
                direct_addrs.push(value.parse().map_err(|e| bad(flag, &e))?)
            }
            ("connect", "--listen") => listen = value.parse().map_err(|e| bad(flag, &e))?,
            _ => return Err(format!("unknown flag {flag} for {command}")),
        }
    }
    let mode = match command.as_str() {
        "serve" => Mode::Serve {
            secret_key_file: secret_key_file.ok_or("serve needs --secret-key-file")?,
            target: target.ok_or("serve needs --target")?,
            bind,
        },
        "connect" => Mode::Connect {
            node_id: node_id.ok_or("connect needs --node-id")?,
            direct_addrs,
            listen,
        },
        other => return Err(format!("unknown command {other}")),
    };
    Ok(Args {
        mode,
        relays: Relays {
            urls: relay_urls,
            ca: relay_ca,
        },
    })
}

/// Loads the hex secret key at `path`, or creates it (mode 0600 on Unix).
fn load_or_create_key(path: &PathBuf) -> std::io::Result<SecretKey> {
    use std::io::{ErrorKind, Write};
    match std::fs::read_to_string(path) {
        Ok(text) => {
            return text
                .trim()
                .parse()
                .map_err(|e| std::io::Error::new(ErrorKind::InvalidData, format!("{e}")));
        }
        Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
        Err(_) => {}
    }
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let key = SecretKey::generate();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    file.write_all(data_encoding::HEXLOWER.encode(&key.to_bytes()).as_bytes())?;
    file.sync_all()?;
    Ok(key)
}

/// Resolves when stdin reaches end of file (or fails). Lines are ignored.
async fn stdin_closed() {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(_)) = lines.next_line().await {}
}

#[tokio::main]
async fn main() -> ExitCode {
    let code = run_main().await;
    // Exit directly: a runtime shutdown would wait on the blocking stdin read.
    std::process::exit(if code == ExitCode::SUCCESS { 0 } else { 1 });
}

async fn run_main() -> ExitCode {
    let args = match parse_args(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("pane-direct: {message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let stdout: Emit = Arc::new(emit);
    let (endpoint, run) = match args.mode {
        Mode::Serve {
            secret_key_file,
            target,
            bind,
        } => {
            let key = match load_or_create_key(&secret_key_file) {
                Ok(key) => key,
                Err(e) => {
                    emit_error(format!(
                        "secret key file {}: {e}",
                        secret_key_file.display()
                    ));
                    return ExitCode::FAILURE;
                }
            };
            let endpoint =
                match bind_endpoint(Some(key), vec![ALPN.to_vec()], bind, &args.relays).await {
                    Ok(endpoint) => endpoint,
                    Err(e) => {
                        emit_error(e);
                        return ExitCode::FAILURE;
                    }
                };
            let run = serve::run(endpoint.clone(), target, stdout);
            (endpoint, Box::pin(run) as RunFuture)
        }
        Mode::Connect {
            node_id,
            direct_addrs,
            listen,
        } => {
            let listener = match TcpListener::bind(listen).await {
                Ok(listener) => listener,
                Err(e) => {
                    emit_error(format!("--listen {listen}: {e}"));
                    return ExitCode::FAILURE;
                }
            };
            let endpoint = match bind_endpoint(None, Vec::new(), None, &args.relays).await {
                Ok(endpoint) => endpoint,
                Err(e) => {
                    emit_error(e);
                    return ExitCode::FAILURE;
                }
            };
            let run = connect::run(
                endpoint.clone(),
                node_id,
                direct_addrs,
                args.relays.urls,
                listener,
                None,
                stdout,
            );
            (endpoint, Box::pin(run) as RunFuture)
        }
    };
    let code = tokio::select! {
        result = run => match result {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                emit_error(message);
                ExitCode::FAILURE
            }
        },
        () = stdin_closed() => ExitCode::SUCCESS,
    };
    // Tell peers we are leaving, but never hang on the way out.
    tokio::time::timeout(Duration::from_secs(2), endpoint.close())
        .await
        .ok();
    code
}
