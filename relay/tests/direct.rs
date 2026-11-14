//! Runs direct/'s `pane-direct serve` and `connect` against a dev relay as their
//! only relay, with no direct addresses given, and carries an HTTP request across.

use clap::Parser;
use pane_relay::Config;
use serde_json::Value;
use std::io::{BufRead, BufReader, Lines, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(30);

/// `PANE_DIRECT_BIN`, else direct/'s debug build (built here when needed).
fn pane_direct() -> PathBuf {
    if let Some(bin) = std::env::var_os("PANE_DIRECT_BIN") {
        return bin.into();
    }
    let direct = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../direct");
    let target = direct.join("target");
    let status = Command::new(env!("CARGO"))
        .args(["build", "--quiet", "--manifest-path"])
        .arg(direct.join("Cargo.toml"))
        .arg("--target-dir")
        .arg(&target)
        .status()
        .expect("run cargo build for direct/");
    assert!(status.success(), "building direct/ failed");
    target.join("debug/pane-direct")
}

struct Helper {
    child: Child,
    // Held open: the helper exits when its stdin closes.
    _stdin: ChildStdin,
    events: mpsc::Receiver<Value>,
}

impl Helper {
    fn start(bin: &PathBuf, args: &[&str]) -> Helper {
        let mut child = Command::new(bin)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("start pane-direct");
        let stdin = child.stdin.take().unwrap();
        let lines: Lines<BufReader<ChildStdout>> =
            BufReader::new(child.stdout.take().unwrap()).lines();
        let (tx, events) = mpsc::channel();
        std::thread::spawn(move || {
            for line in lines.map_while(Result::ok) {
                if let Ok(event) = serde_json::from_str(&line) {
                    let _ = tx.send(event);
                }
            }
        });
        Helper {
            child,
            _stdin: stdin,
            events,
        }
    }

    fn next_event(&self, kind: &str) -> Value {
        loop {
            let event = self
                .events
                .recv_timeout(WAIT)
                .unwrap_or_else(|_| panic!("no {kind} event"));
            if event["t"] == kind {
                return event;
            }
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
    }
}

/// Stands in for the computer's Pane server: answers `GET /hello` with `hello`.
fn computer_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for socket in listener.incoming() {
            let mut socket = socket.unwrap();
            let mut request = [0u8; 1024];
            let read = socket.read(&mut request).unwrap_or(0);
            let reply: &[u8] = if request[..read].starts_with(b"GET /hello ") {
                b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello"
            } else {
                b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n"
            };
            socket.write_all(reply).ok();
        }
    });
    port
}

#[tokio::test(flavor = "multi_thread")]
async fn a_request_crosses_a_direct_path_met_at_the_relay() {
    let bin = tokio::task::spawn_blocking(pane_direct).await.unwrap();
    let relay = pane_relay::start(Config::parse_from([
        "pane-relay",
        "--dev",
        "--listen",
        "127.0.0.1:0",
        "--direct-quic",
        "127.0.0.1:0",
    ]))
    .await
    .unwrap();
    assert!(relay.direct_quic_addr.is_some());
    let relay_url = format!("https://127.0.0.1:{}/", relay.https_addr.port());
    let ca = relay.dev_cert.clone().unwrap().display().to_string();
    let key = std::env::temp_dir().join(format!(
        "pane-relay-direct-test-{}.noindex/key",
        std::process::id()
    ));
    let target = format!("127.0.0.1:{}", computer_server());

    let response = tokio::task::spawn_blocking(move || {
        let serve = Helper::start(
            &bin,
            &[
                "serve",
                "--secret-key-file",
                key.to_str().unwrap(),
                "--target",
                &target,
                "--relay-url",
                &relay_url,
                "--relay-ca",
                &ca,
            ],
        );
        let node_id = serve.next_event("ready")["nodeId"]
            .as_str()
            .unwrap()
            .to_string();
        let connect = Helper::start(
            &bin,
            &[
                "connect",
                "--node-id",
                &node_id,
                "--relay-url",
                &relay_url,
                "--relay-ca",
                &ca,
            ],
        );
        let port = connect.next_event("ready")["port"].as_u64().unwrap() as u16;
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client.set_read_timeout(Some(WAIT)).unwrap();
        client
            .write_all(b"GET /hello HTTP/1.1\r\nhost: x\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).ok();
        std::fs::remove_dir_all(key.parent().unwrap()).ok();
        response
    })
    .await
    .unwrap();
    assert!(response.ends_with("\r\n\r\nhello"), "{response:?}");
    relay.shutdown().await;
}
