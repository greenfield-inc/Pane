//! `pane-direct`: carries a Pane computer's TLS byte stream over an iroh QUIC
//! connection. See README.md for the stdin/stdout protocol.

mod connect;
mod serve;

use std::{
    future::Future, net::SocketAddr, path::PathBuf, pin::Pin, process::ExitCode, time::Duration,
};

use iroh::{
    Endpoint, EndpointId, RelayMode, RelayUrl, SecretKey,
    endpoint::{RecvStream, SendStream, presets},
};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};

type RunFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

pub const ALPN: &[u8] = b"pane/direct/1";

const USAGE: &str = "usage:
  pane-direct serve --secret-key-file <path> --target <ip:port> [--bind <ip:port>] [--relay-url <url>]...
  pane-direct connect --node-id <id> [--relay-url <url>]... [--direct-addr <ip:port>]... [--listen <ip:port>]";

/// Writes one JSON line to stdout. `println!` locks stdout per call, so lines
/// from concurrent tasks never interleave.
pub fn emit(event: Value) {
    println!("{event}");
}

pub fn emit_error(message: impl std::fmt::Display) {
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
    relay_urls: Vec<RelayUrl>,
}

fn parse_args(mut argv: impl Iterator<Item = String>) -> Result<Args, String> {
    let command = argv.next().ok_or("missing command")?;
    let mut flags: Vec<(String, String)> = Vec::new();
    while let Some(flag) = argv.next() {
        let value = argv.next().ok_or_else(|| format!("{flag} needs a value"))?;
        flags.push((flag, value));
    }
    let mut relay_urls = Vec::new();
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
    Ok(Args { mode, relay_urls })
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

async fn bind_endpoint(
    secret_key: Option<SecretKey>,
    alpns: Vec<Vec<u8>>,
    bind: Option<SocketAddr>,
    relay_urls: &[RelayUrl],
) -> Result<Endpoint, String> {
    // Builder::new starts with no address lookup and relays disabled; relays
    // are only the ones Pane names, never n0's public defaults.
    let mut builder = Endpoint::builder(presets::Minimal).alpns(alpns);
    if !relay_urls.is_empty() {
        builder = builder.relay_mode(RelayMode::custom(relay_urls.iter().cloned()));
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
                match bind_endpoint(Some(key), vec![ALPN.to_vec()], bind, &args.relay_urls).await {
                    Ok(endpoint) => endpoint,
                    Err(e) => {
                        emit_error(e);
                        return ExitCode::FAILURE;
                    }
                };
            let run = serve::run(endpoint.clone(), target);
            (endpoint, Box::pin(run) as RunFuture)
        }
        Mode::Connect {
            node_id,
            direct_addrs,
            listen,
        } => {
            let endpoint = match bind_endpoint(None, Vec::new(), None, &args.relay_urls).await {
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
                args.relay_urls,
                listen,
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
