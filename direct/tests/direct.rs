//! Runs `serve` and `connect` as the desktop and phone would, and carries an
//! HTTP request across the direct path.

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdin, Command, Stdio},
    thread,
};

use serde_json::Value;

struct Helper {
    child: Child,
    // Held open: the helper exits when its stdin closes.
    _stdin: ChildStdin,
    lines: std::io::Lines<BufReader<std::process::ChildStdout>>,
}

impl Helper {
    fn start(args: &[&str]) -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_pane-direct"))
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("start pane-direct");
        let stdin = child.stdin.take().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        Helper {
            child,
            _stdin: stdin,
            lines,
        }
    }

    fn next_event(&mut self, kind: &str) -> Value {
        for line in self.lines.by_ref() {
            let event: Value = serde_json::from_str(&line.unwrap()).unwrap();
            if event["t"] == kind {
                return event;
            }
            assert_ne!(event["t"], "error", "{event}");
        }
        panic!("pane-direct exited before {kind}");
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
    }
}

/// An HTTP server standing in for the computer's Pane server. It answers
/// `GET /hello` once; other requests (a local port scanner's probes) get 404.
fn computer_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for socket in listener.incoming() {
            let mut socket = socket.unwrap();
            let mut request = [0u8; 1024];
            let read = socket.read(&mut request).unwrap_or(0);
            if request[..read].starts_with(b"GET /hello ") {
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello",
                    )
                    .unwrap();
                return;
            }
            socket
                .write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n")
                .ok();
        }
    });
    port
}

#[test]
fn a_request_crosses_the_direct_path() {
    let dir = std::env::temp_dir().join(format!("pane-direct-test-{}", std::process::id()));
    let key = dir.join("key");
    let target = format!("127.0.0.1:{}", computer_server());
    let bind = {
        let probe = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        probe.local_addr().unwrap().to_string()
    };

    let mut serve = Helper::start(&[
        "serve",
        "--secret-key-file",
        key.to_str().unwrap(),
        "--target",
        &target,
        "--bind",
        &bind,
    ]);
    let ready = serve.next_event("ready");
    let node_id = ready["nodeId"].as_str().unwrap().to_string();

    let mut connect = Helper::start(&["connect", "--node-id", &node_id, "--direct-addr", &bind]);
    let port = connect.next_event("ready")["port"].as_u64().unwrap();

    let mut client = TcpStream::connect(("127.0.0.1", port as u16)).unwrap();
    client
        .write_all(b"GET /hello HTTP/1.1\r\nhost: x\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    assert!(response.ends_with("\r\n\r\nhello"), "{response}");
    assert_eq!(connect.next_event("path")["path"], "direct");

    // The same key file gives the same node id, so phones keep the computer's address.
    drop(serve);
    let mut again = Helper::start(&[
        "serve",
        "--secret-key-file",
        key.to_str().unwrap(),
        "--target",
        &target,
        "--bind",
        &bind,
    ]);
    assert_eq!(again.next_event("ready")["nodeId"], node_id.as_str());
    std::fs::remove_dir_all(&dir).ok();
}
