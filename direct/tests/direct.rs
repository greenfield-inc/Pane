//! Runs `serve` and `connect` as the desktop and phone would, and carries an
//! HTTP request across the direct path.

use std::{
    ffi::{CStr, CString},
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, mpsc},
    thread,
};

use pane_direct::ffi;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{Value, json};

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

/// The computer's TLS listener: a certificate for `c1.pane.localhost` whose key
/// fingerprint (from `openssl x509 -pubkey | openssl pkey -pubin -outform der |
/// sha256 | base64url`) is `COMPUTER_KEY`. Reports the SNI of each handshake.
const COMPUTER_KEY: &str = "5JI1TmlcHCYNGZO6bPCID6uAGLO5uAkmRFjpN28TwFw";

fn computer_tls_server() -> (u16, mpsc::Receiver<String>) {
    let cert = CertificateDer::from(include_bytes!("fixtures/computer-cert.der").to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        include_bytes!("fixtures/computer-key.der").to_vec(),
    ));
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![cert], key)
    .unwrap();
    let config = Arc::new(config);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (names, names_rx) = mpsc::channel();
    thread::spawn(move || {
        for socket in listener.incoming() {
            let (config, names) = (config.clone(), names.clone());
            thread::spawn(move || {
                let conn = rustls::ServerConnection::new(config).unwrap();
                let mut tls = rustls::StreamOwned::new(conn, socket.unwrap());
                let mut request = [0u8; 1024];
                let Ok(read) = tls.read(&mut request) else {
                    return;
                };
                names
                    .send(tls.conn.server_name().unwrap_or("").to_string())
                    .ok();
                if request[..read].starts_with(b"GET /hello ") {
                    tls.write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello",
                    )
                    .ok();
                    tls.conn.send_close_notify();
                    tls.flush().ok();
                }
            });
        }
    });
    (port, names_rx)
}

/// What the Pane app does through the C ABI: start `connect` with the
/// computer's name and key, then send plain HTTP to the port it returns.
fn app_connect(node_id: &str, direct_addr: &str, fingerprint: &str) -> (u64, u16) {
    let config = json!({
        "nodeId": node_id,
        "relayUrls": [],
        "directAddrs": [direct_addr, "not-an-address"],
        "serverName": "c1.pane.localhost",
        "fingerprint": fingerprint,
    });
    let config = CString::new(config.to_string()).unwrap();
    let result = unsafe { ffi::pane_direct_connect(config.as_ptr()) };
    let value: Value = serde_json::from_str(&take_string(result)).unwrap();
    (
        value["id"].as_u64().expect("id"),
        value["port"].as_u64().unwrap() as u16,
    )
}

fn take_string(text: *mut std::ffi::c_char) -> String {
    let value = unsafe { CStr::from_ptr(text) }
        .to_string_lossy()
        .into_owned();
    unsafe { ffi::pane_direct_free_string(text) };
    value
}

fn next_app_event(id: u64, kind: &str) -> Value {
    loop {
        let text = ffi::pane_direct_next_event(id, 10_000);
        assert!(!text.is_null(), "no {kind} event within 10 s");
        let event: Value = serde_json::from_str(&take_string(text)).unwrap();
        if event["t"] == kind {
            return event;
        }
        assert_ne!(event["t"], "closed", "closed before {kind}");
    }
}

fn get_hello(port: u16) -> String {
    let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
    client
        .write_all(b"GET /hello HTTP/1.1\r\nhost: x\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).ok();
    response
}

#[test]
fn the_app_reaches_the_computer_over_tls_to_its_pinned_key() {
    let dir = std::env::temp_dir().join(format!("pane-direct-app-test-{}", std::process::id()));
    let (tls_port, names) = computer_tls_server();
    let target = format!("127.0.0.1:{tls_port}");
    let bind = {
        let probe = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        probe.local_addr().unwrap().to_string()
    };
    let mut serve = Helper::start(&[
        "serve",
        "--secret-key-file",
        dir.join("key").to_str().unwrap(),
        "--target",
        &target,
        "--bind",
        &bind,
    ]);
    let node_id = serve.next_event("ready")["nodeId"]
        .as_str()
        .unwrap()
        .to_string();

    let (id, port) = app_connect(&node_id, &bind, COMPUTER_KEY);
    let response = get_hello(port);
    assert!(response.ends_with("\r\n\r\nhello"), "{response}");
    assert_eq!(names.recv().unwrap(), "c1.pane.localhost");
    assert_eq!(next_app_event(id, "path")["path"], "direct");
    ffi::pane_direct_close(id);
    assert_eq!(next_app_event(id, "closed")["t"], "closed");

    // A computer showing another key gets no request.
    let (id, port) = app_connect(
        &node_id,
        &bind,
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    assert_eq!(get_hello(port), "");
    assert!(
        names.try_recv().is_err(),
        "the request reached the computer"
    );
    ffi::pane_direct_close(id);
    std::fs::remove_dir_all(&dir).ok();
}
