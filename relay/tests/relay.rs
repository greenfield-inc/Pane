//! Drives a relay on loopback through its public interfaces: TLS, the agent protocol, HTTP and DNS.

use clap::Parser;
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use hickory_proto::op::{Message, Query, ResponseCode};
use hickory_proto::rr::{Name, RData, RecordType};
use p256::ecdsa::{DerSignature, SigningKey, signature::Signer};
use p256::elliptic_curve::Generate;
use p256::pkcs8::{DecodePrivateKey, EncodePublicKey};
use pane_relay::{Config, Relay};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use serde_json::{Value, json};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, ReadHalf, WriteHalf};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::mpsc;
use tokio_rustls::client::TlsStream;

const D: &str = "relay.test";
const WAIT: Duration = Duration::from_secs(5);

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn scratch_dir() -> PathBuf {
    let mut rnd = [0u8; 8];
    getrandom::fill(&mut rnd).unwrap();
    let dir =
        std::env::temp_dir().join(format!("pane-relay-test-{}.noindex", HEXLOWER.encode(&rnd)));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct Env {
    relay: Option<Relay>,
    relay_cert: CertificateDer<'static>,
    dir: PathBuf,
}

/// One certificate for every test relay, so relays can trust each other
/// (`--provider-ca {dir}/cert.pem`) and reach each other at 127.0.0.1.
fn relay_cert() -> &'static rcgen::CertifiedKey<rcgen::KeyPair> {
    static CERT: std::sync::OnceLock<rcgen::CertifiedKey<rcgen::KeyPair>> =
        std::sync::OnceLock::new();
    CERT.get_or_init(|| {
        let names = vec![D.to_string(), format!("*.relay.{D}"), "127.0.0.1".into()];
        rcgen::generate_simple_self_signed(names).unwrap()
    })
}

impl Env {
    async fn start(extra: &[&str]) -> Env {
        let dir = scratch_dir();
        let ck = relay_cert();
        std::fs::write(dir.join("cert.pem"), ck.cert.pem()).unwrap();
        std::fs::write(dir.join("key.pem"), ck.signing_key.serialize_pem()).unwrap();
        let mut args = vec!["pane-relay".to_string(), "--domain".into(), D.into()];
        if !extra.contains(&"--listen") {
            args.extend(["--listen".into(), "127.0.0.1:0".into()]);
        }
        args.extend([
            "--cert".into(),
            dir.join("cert.pem").display().to_string(),
            "--key".into(),
            dir.join("key.pem").display().to_string(),
        ]);
        args.extend(
            extra
                .iter()
                .map(|s| s.replace("{dir}", &dir.display().to_string())),
        );
        let relay = pane_relay::start(Config::parse_from(args)).await.unwrap();
        Env {
            relay: Some(relay),
            relay_cert: ck.cert.der().clone(),
            dir,
        }
    }

    /// The relay's https address over IPv4 loopback.
    fn addr(&self) -> SocketAddr {
        let port = self.relay.as_ref().unwrap().https_addr.port();
        SocketAddr::from((Ipv4Addr::LOCALHOST, port))
    }

    /// The same listener over IPv6 loopback, a second client address (needs `--listen [::]:0`).
    fn addr_v6(&self) -> SocketAddr {
        let port = self.relay.as_ref().unwrap().https_addr.port();
        SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port))
    }

    fn dns(&self) -> SocketAddr {
        self.relay.as_ref().unwrap().dns_addr.unwrap()
    }

    async fn connect_relay(&self, sni: &str) -> TlsStream<TcpStream> {
        tls_connect(self.addr(), sni, &self.relay_cert)
            .await
            .unwrap()
    }

    /// One HTTP/1.1 request to the relay's API; returns the status and body.
    async fn http(&self, method: &str, path: &str, headers: &str, body: &str) -> (u16, String) {
        let mut s = self.connect_relay(D).await;
        let req = format!(
            "{method} {path} HTTP/1.1\r\nhost: {D}\r\ncontent-length: {}\r\n{headers}\r\n{body}",
            body.len()
        );
        s.write_all(req.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out).await;
        let text = String::from_utf8_lossy(&out).to_string();
        let status = text[9..12].parse().unwrap();
        let body = text
            .split_once("\r\n\r\n")
            .map(|(_, b)| b.to_string())
            .unwrap_or_default();
        (status, body)
    }

    async fn status(&self, id: &str) -> Value {
        let (code, body) = self.http("GET", &format!("/v1/status/{id}"), "", "").await;
        assert_eq!(code, 200);
        serde_json::from_str(&body).unwrap()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn tls_connect(
    addr: SocketAddr,
    sni: &str,
    root: &CertificateDer<'static>,
) -> std::io::Result<TlsStream<TcpStream>> {
    let mut roots = rustls::RootCertStore::empty();
    roots.add(root.clone()).unwrap();
    let cfg = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let tcp = TcpStream::connect(addr).await?;
    tokio_rustls::TlsConnector::from(Arc::new(cfg))
        .connect(ServerName::try_from(sni.to_string()).unwrap(), tcp)
        .await
}

/// Reads an HTTP response head byte by byte so nothing after it is consumed.
async fn read_head<S: AsyncReadExt + Unpin>(s: &mut S) -> String {
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        let mut b = [0u8; 1];
        if s.read(&mut b).await.unwrap() == 0 {
            break;
        }
        head.push(b[0]);
    }
    String::from_utf8(head).unwrap()
}

async fn upgrade(
    env_addr: SocketAddr,
    cert: &CertificateDer<'static>,
    path: &str,
) -> (TlsStream<TcpStream>, String) {
    let mut s = tls_connect(env_addr, &format!("us.relay.{D}"), cert)
        .await
        .unwrap();
    let req = format!(
        "GET {path} HTTP/1.1\r\nhost: us.relay.{D}\r\nupgrade: pane-relay/1\r\nconnection: Upgrade\r\n\r\n"
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let head = read_head(&mut s).await;
    (s, head)
}

/// A fake Pane computer: holds a P-256 identity key and its own certificate for <id>.<D>.
struct Agent {
    id: String,
    cert: CertificateDer<'static>,
    writer: WriteHalf<TlsStream<TcpStream>>,
    frames: mpsc::UnboundedReceiver<Value>,
}

enum Sign {
    Correctly,
    WrongNonce,
}

impl Agent {
    async fn connect(env: &Env, key: &SigningKey) -> Agent {
        Self::try_connect(env, key, Sign::Correctly).await.unwrap()
    }

    /// Runs the handshake. On success, a background task answers `open` frames
    /// by serving TLS for <id>.<D> on a data connection; other frames arrive in `frames`.
    async fn try_connect(env: &Env, key: &SigningKey, sign: Sign) -> Result<Agent, Value> {
        let (s, head) = upgrade(env.addr(), &env.relay_cert, "/v1/agent").await;
        assert!(head.starts_with("HTTP/1.1 101"), "{head}");
        let (rd, mut writer) = tokio::io::split(s);
        let mut rd = BufReader::new(rd);
        let challenge = read_frame(&mut rd).await.unwrap();
        if challenge["t"] != "challenge" {
            return Err(challenge);
        }
        let nonce = challenge["nonce"].as_str().unwrap();
        let signed = match sign {
            Sign::Correctly => format!("pane-relay-v1:{nonce}"),
            Sign::WrongNonce => format!("pane-relay-v1:{nonce}x"),
        };
        let sig: DerSignature = key.sign(signed.as_bytes());
        let spki = key.verifying_key().to_public_key_der().unwrap();
        let hello = json!({"t": "hello", "v": 1, "spki": BASE64URL_NOPAD.encode(spki.as_bytes()),
            "sig": BASE64URL_NOPAD.encode(sig.as_bytes()), "local": ["192.168.1.20"], "name": "Studio Mac"});
        send(&mut writer, &hello).await;
        let welcome = read_frame(&mut rd).await.unwrap();
        if welcome["t"] != "welcome" {
            return Err(welcome);
        }
        let id = welcome["id"].as_str().unwrap().to_string();
        let names = vec![format!("{id}.{D}"), format!("*.{id}.{D}")];
        let ck = rcgen::generate_simple_self_signed(names).unwrap();
        let cert = ck.cert.der().clone();
        let tls = rustls::ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.clone()],
                PrivateKeyDer::try_from(ck.signing_key.serialize_der()).unwrap(),
            )
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let (tx, frames) = mpsc::unbounded_channel();
        let (addr, relay_cert) = (env.addr(), env.relay_cert.clone());
        tokio::spawn(async move {
            while let Some(frame) = read_frame(&mut rd).await {
                if frame["t"] != "open" {
                    let _ = tx.send(frame);
                    continue;
                }
                let (acceptor, relay_cert) = (acceptor.clone(), relay_cert.clone());
                let conn = frame["conn"].as_str().unwrap().to_string();
                tokio::spawn(async move {
                    let (data, head) =
                        upgrade(addr, &relay_cert, &format!("/v1/data/{conn}")).await;
                    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
                    // End the client's TLS with this computer's own certificate and echo one line.
                    // After `upload <n>` it reads the n bytes that follow slowly, as a computer on a slow
                    // link does, and answers with the count.
                    let tls = acceptor.accept(data).await.unwrap();
                    let sni = tls.get_ref().1.server_name().unwrap_or("").to_string();
                    let (r, mut w) = tokio::io::split(tls);
                    let mut r = BufReader::new(r);
                    let mut line = String::new();
                    r.read_line(&mut line).await.unwrap();
                    if let Some(n) = line.trim().strip_prefix("upload ") {
                        let (want, mut got) = (n.parse::<usize>().unwrap(), 0);
                        let mut buf = vec![0u8; 64 * 1024];
                        while got < want {
                            tokio::time::sleep(Duration::from_millis(4)).await;
                            let take = buf.len().min(want - got);
                            got += r.read(&mut buf[..take]).await.unwrap();
                        }
                        line = format!("got {got}\n");
                    }
                    w.write_all(format!("{sni} {line}").as_bytes())
                        .await
                        .unwrap();
                    w.shutdown().await.unwrap();
                });
            }
        });
        Ok(Agent {
            id,
            cert,
            writer,
            frames,
        })
    }

    async fn send(&mut self, v: Value) {
        send(&mut self.writer, &v).await;
    }

    /// Closes the control connection, as a computer that quits does.
    async fn close(mut self) {
        self.writer.shutdown().await.unwrap();
    }

    async fn next(&mut self) -> Value {
        tokio::time::timeout(WAIT, self.frames.recv())
            .await
            .expect("frame in time")
            .expect("connection open")
    }

    /// A client connects to `sni` through the relay, sends a line and returns the computer's answer.
    async fn exchange(&self, env: &Env, sni: &str) -> std::io::Result<String> {
        self.exchange_from(env.addr(), sni).await
    }

    /// Like `exchange`, connecting to the relay at `addr`.
    async fn exchange_from(&self, addr: SocketAddr, sni: &str) -> std::io::Result<String> {
        let mut s = tls_connect(addr, sni, &self.cert).await?;
        s.write_all(b"ping\n").await?;
        let mut out = String::new();
        s.read_to_string(&mut out).await?;
        Ok(out)
    }
}

impl Agent {
    /// A client sends `bytes` bytes to `sni` through the relay at `addr`. Returns the
    /// computer's answer and how long the upload took.
    async fn upload(
        &self,
        addr: SocketAddr,
        sni: &str,
        bytes: u64,
    ) -> std::io::Result<(String, Duration)> {
        let started = std::time::Instant::now();
        let mut s = tls_connect(addr, sni, &self.cert).await?;
        s.write_all(format!("upload {bytes}\n").as_bytes()).await?;
        let chunk = vec![7u8; 256 * 1024];
        let mut left = bytes;
        while left > 0 {
            let n = left.min(chunk.len() as u64) as usize;
            s.write_all(&chunk[..n]).await?;
            left -= n as u64;
        }
        s.flush().await?;
        let mut out = String::new();
        s.read_to_string(&mut out).await?;
        Ok((out, started.elapsed()))
    }
}

async fn send(w: &mut WriteHalf<TlsStream<TcpStream>>, v: &Value) {
    w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
    w.flush().await.unwrap();
}

async fn read_frame(r: &mut BufReader<ReadHalf<TlsStream<TcpStream>>>) -> Option<Value> {
    let mut line = String::new();
    match tokio::time::timeout(WAIT, r.read_line(&mut line)).await {
        Ok(Ok(n)) if n > 0 => Some(serde_json::from_str(&line).unwrap()),
        _ => None,
    }
}

fn fixed_key() -> SigningKey {
    let der = HEXLOWER.decode(b"308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b02010104201e2aba68c14ecc9d09ee4eda659e7291f02905e1fe9ca4a2771585d43676c7c7a144034200049f41bf47d78ab59a7c9564a4513b42a0b09f487d3108cb8e45b031ddb3e54c2b55ac3976268358d4d204a91c0e98b37deef145eaad065dee146299b1f367e9b5").unwrap();
    SigningKey::from_pkcs8_der(&der).unwrap()
}

/// The id of `fixed_key`, computed with openssl: sha256 of `openssl pkey -pubout -outform DER`,
/// first 10 bytes, lowercase base32.
const FIXED_ID: &str = "2hlqznkqugk2oeju";

#[tokio::test]
async fn client_tls_reaches_the_computer_end_to_end() {
    let env = Env::start(&[]).await;
    let agent = Agent::connect(&env, &fixed_key()).await;
    assert_eq!(agent.id, FIXED_ID);

    let host = format!("{FIXED_ID}.{D}");
    assert_eq!(
        agent.exchange(&env, &host).await.unwrap(),
        format!("{host} ping\n")
    );
    let dev = format!("p5173.{FIXED_ID}.{D}");
    assert_eq!(
        agent.exchange(&env, &dev).await.unwrap(),
        format!("{dev} ping\n")
    );

    let (code, body) = env.http("GET", "/healthz", "", "").await;
    assert_eq!(code, 200);
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        json!({"ok": true, "region": "us", "computers": 1})
    );
}

#[tokio::test]
async fn an_upload_reaches_a_computer_on_a_slow_link() {
    let env = Env::start(&[]).await;
    let agent = Agent::connect(&env, &fixed_key()).await;
    let host = format!("{FIXED_ID}.{D}");
    let body = vec![7u8; 32 * 1024 * 1024];
    let mut s = tls_connect(env.addr(), &host, &agent.cert).await.unwrap();
    s.write_all(format!("upload {}\n", body.len()).as_bytes())
        .await
        .unwrap();
    s.write_all(&body).await.unwrap();
    s.flush().await.unwrap();
    // The client then only waits for the answer, so nothing it sends can push the relay along.
    let mut out = String::new();
    tokio::time::timeout(Duration::from_secs(30), s.read_to_string(&mut out))
        .await
        .expect("the computer got the whole upload in time")
        .unwrap();
    assert_eq!(out, format!("{host} got {}\n", body.len()));
}

#[tokio::test]
async fn hello_with_a_bad_signature_is_refused() {
    let env = Env::start(&[]).await;
    let err = Agent::try_connect(&env, &SigningKey::generate(), Sign::WrongNonce)
        .await
        .err()
        .unwrap();
    assert_eq!(err["t"], "error");
    assert_eq!(err["code"], "bad-signature");
}

#[tokio::test]
async fn second_control_connection_replaces_the_first() {
    let env = Env::start(&[]).await;
    let key = SigningKey::generate();
    let mut first = Agent::connect(&env, &key).await;
    let second = Agent::connect(&env, &key).await;
    let close = first.next().await;
    assert_eq!(
        (close["t"].as_str(), close["code"].as_str()),
        (Some("close"), Some("replaced"))
    );

    // Clients now reach the second connection.
    let host = format!("{}.{D}", second.id);
    assert_eq!(
        second.exchange(&env, &host).await.unwrap(),
        format!("{host} ping\n")
    );
}

#[tokio::test]
async fn unknown_data_connection_gets_404() {
    let env = Env::start(&[]).await;
    let (_, head) = upgrade(
        env.addr(),
        &env.relay_cert,
        "/v1/data/AAAAAAAAAAAAAAAAAAAAAA",
    )
    .await;
    assert!(head.starts_with("HTTP/1.1 404"), "{head}");
}

#[tokio::test]
async fn blocklisted_ids_are_refused_and_cut_off() {
    let env = Env::start(&["--blocklist", "{dir}/blocked.txt"]).await;
    std::fs::write(env.dir.join("blocked.txt"), format!("{FIXED_ID}\n")).unwrap();
    // The relay rereads the file within 5 s.
    let deadline = Instant::now() + Duration::from_secs(8);
    let err = loop {
        match Agent::try_connect(&env, &fixed_key(), Sign::Correctly).await {
            Err(e) => break e,
            Ok(_) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(500)).await
            }
            Ok(_) => panic!("blocklist was not reread"),
        }
    };
    assert_eq!(err["code"], "blocked");

    // Blocking a connected computer cuts it off.
    let key = SigningKey::generate();
    let mut agent = Agent::connect(&env, &key).await;
    std::fs::write(
        env.dir.join("blocked.txt"),
        format!("{FIXED_ID}\n{}\n", agent.id),
    )
    .unwrap();
    let close = tokio::time::timeout(Duration::from_secs(8), agent.frames.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (close["t"].as_str(), close["code"].as_str()),
        (Some("close"), Some("blocked"))
    );
}

#[tokio::test]
async fn status_reports_online_asleep_and_offline() {
    let env = Env::start(&[]).await;
    let key = SigningKey::generate();
    let id =
        pane_relay::id::id_from_spki(key.verifying_key().to_public_key_der().unwrap().as_bytes());
    assert_eq!(
        env.status(&id).await,
        json!({"state": "offline", "since": null})
    );

    let mut agent = Agent::connect(&env, &key).await;
    let online = env.status(&id).await;
    assert_eq!(online["state"], "online");
    assert!(online["since"].as_str().unwrap().ends_with('Z'));

    agent.send(json!({"t": "sleep"})).await;
    agent.send(json!({"t": "ping"})).await;
    assert_eq!(agent.next().await["t"], "pong");
    assert_eq!(env.status(&id).await["state"], "asleep");
    drop(agent);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(env.status(&id).await["state"], "asleep");

    let agent = Agent::connect(&env, &key).await;
    assert_eq!(env.status(&id).await["state"], "online");
    drop(agent);
    let deadline = Instant::now() + WAIT;
    while env.status(&id).await["state"] != "offline" {
        assert!(Instant::now() < deadline, "never went offline");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn the_phone_app_opens_pair_and_glasses_links() {
    let env = Env::start(&[]).await;
    let (code, body) = env
        .http("GET", "/.well-known/apple-app-site-association", "", "")
        .await;
    assert_eq!(code, 200);
    let aasa: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        aasa["applinks"]["details"][0]["components"],
        json!([{"/": "/pair*"}, {"/": "/glasses*"}])
    );
    for path in ["/pair", "/glasses"] {
        let (code, body) = env.http("GET", path, "", "").await;
        assert_eq!(code, 200, "{path}");
        assert!(
            body.contains("https://testflight.apple.com/join/eKJmnzXF"),
            "{path}"
        );
    }
}

async fn dns_query(server: SocketAddr, name: String, rtype: RecordType, tcp: bool) -> Message {
    let mut q = Message::query();
    q.metadata.id = 7;
    q.add_query(Query::query(Name::from_ascii(&name).unwrap(), rtype));
    let bytes = q.to_vec().unwrap();
    let resp = if tcp {
        let mut s = TcpStream::connect(server).await.unwrap();
        s.write_u16(bytes.len() as u16).await.unwrap();
        s.write_all(&bytes).await.unwrap();
        let len = s.read_u16().await.unwrap() as usize;
        let mut buf = vec![0u8; len];
        s.read_exact(&mut buf).await.unwrap();
        buf
    } else {
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        sock.send_to(&bytes, server).await.unwrap();
        let mut buf = vec![0u8; 2048];
        let n = tokio::time::timeout(WAIT, sock.recv(&mut buf))
            .await
            .unwrap()
            .unwrap();
        buf.truncate(n);
        buf
    };
    let m = Message::from_vec(&resp).unwrap();
    assert_eq!(m.metadata.id, 7);
    m
}

fn a_records(m: &Message) -> Vec<Ipv4Addr> {
    m.answers
        .iter()
        .filter_map(|r| match &r.data {
            RData::A(a) => Some(a.0),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn caa_lets_only_lets_encrypt_and_google_trust_services_issue_and_no_wildcard_for_the_whole_domain()
 {
    let env = Env::start(&["--dns", "127.0.0.1:0", "--public-ip", "203.0.113.10"]).await;
    let agent = Agent::connect(&env, &SigningKey::generate()).await;
    let id = agent.id.clone();
    let dns = env.dns();
    let caa = |name: String| async move {
        let mut values: Vec<String> = dns_query(dns, name, RecordType::CAA, false)
            .await
            .answers
            .iter()
            .map(|r| r.data.to_string())
            .collect();
        values.sort();
        values
    };
    // A certificate for *.<D> would cover every computer's name.
    assert_eq!(
        caa(format!("{D}.")).await,
        vec![
            "0 issue \"letsencrypt.org\"",
            "0 issue \"pki.goog\"",
            "0 issuewild \";\""
        ]
    );
    // Each computer's own names, *.<id>.<D> included, only through DNS-01 at those two CAs,
    // whether or not the relay knows the id.
    for name in [format!("{id}.{D}."), format!("aaaaaaaaaaaaaaaa.{D}.")] {
        assert_eq!(
            caa(name).await,
            vec![
                "0 issue \"letsencrypt.org; validationmethods=dns-01\"",
                "0 issue \"pki.goog; validationmethods=dns-01\"",
                "0 issuewild \"letsencrypt.org; validationmethods=dns-01\"",
                "0 issuewild \"pki.goog; validationmethods=dns-01\"",
            ]
        );
    }

    // A self-hosted relay on another CA names it, or serves none.
    let other = Env::start(&[
        "--dns",
        "127.0.0.1:0",
        "--public-ip",
        "203.0.113.10",
        "--caa-issuer",
        "",
    ])
    .await;
    let none = dns_query(other.dns(), format!("{D}."), RecordType::CAA, false).await;
    assert!(none.answers.is_empty());
}

#[tokio::test]
async fn dns_answers_for_computer_names() {
    let env = Env::start(&[
        "--dns",
        "127.0.0.1:0",
        "--public-ip",
        "203.0.113.10",
        "--region-ip",
        "us=203.0.113.10,eu=198.51.100.7",
        "--registry-secret",
        "s3cret",
    ])
    .await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let id = agent.id.clone();
    let us = Ipv4Addr::new(203, 0, 113, 10);
    let a = |name: String| dns_query(env.dns(), name, RecordType::A, false);

    assert_eq!(a_records(&a(format!("{id}.{D}.")).await), vec![us]);
    assert_eq!(a_records(&a(format!("p5173.{id}.{D}.")).await), vec![us]);
    assert_eq!(a_records(&a(format!("{D}.")).await), vec![us]);
    assert_eq!(
        a_records(&a(format!("eu.relay.{D}.")).await),
        vec![Ipv4Addr::new(198, 51, 100, 7)]
    );
    assert_eq!(
        a_records(&a(format!("l192-168-1-20.{id}.{D}.")).await),
        vec![Ipv4Addr::new(192, 168, 1, 20)]
    );
    assert_eq!(
        a_records(&a(format!("l100-64-0-1.{id}.{D}.")).await),
        vec![Ipv4Addr::new(100, 64, 0, 1)]
    );
    assert_eq!(
        a(format!("l8-8-8-8.{id}.{D}."))
            .await
            .metadata
            .response_code,
        ResponseCode::NXDomain
    );
    // A computer the relay doesn't know (asleep and forgotten, or never seen) answers as if it
    // were here, briefly: a cached "no such name" outlasts its return, on macOS by up to an hour.
    let unknown = a(format!("aaaaaaaaaaaaaaaa.{D}.")).await;
    assert_eq!(a_records(&unknown), vec![us]);
    assert_eq!(unknown.answers[0].ttl, 10);
    assert_eq!(
        a_records(&a(format!("p5173.aaaaaaaaaaaaaaaa.{D}.")).await),
        vec![us]
    );
    assert_eq!(a(format!("{id}.{D}.")).await.answers[0].ttl, 60);
    assert_eq!(
        a_records(&a(format!("files.aaaaaaaaaaaaaaaa.{D}.")).await),
        vec![us]
    );
    assert_eq!(
        a_records(&a(format!("l192-168-1-20.aaaaaaaaaaaaaaaa.{D}.")).await),
        vec![Ipv4Addr::new(192, 168, 1, 20)]
    );
    let txt = dns_query(
        env.dns(),
        format!("_acme-challenge.aaaaaaaaaaaaaaaa.{D}."),
        RecordType::TXT,
        false,
    )
    .await;
    assert_eq!(txt.metadata.response_code, ResponseCode::NoError);
    assert!(txt.answers.is_empty());
    assert_eq!(
        a(format!("www.{D}.")).await.metadata.response_code,
        ResponseCode::NXDomain
    );

    // TXT values set over the control connection, read over TCP.
    agent
        .send(json!({"t": "txt", "req": "1", "values": ["token-abc"]}))
        .await;
    assert_eq!(agent.next().await, json!({"t": "ok", "req": "1"}));
    let txt = dns_query(
        env.dns(),
        format!("_acme-challenge.{id}.{D}."),
        RecordType::TXT,
        true,
    )
    .await;
    let values: Vec<Vec<u8>> = txt
        .answers
        .iter()
        .filter_map(|r| match &r.data {
            RData::TXT(t) => Some(t.txt_data.concat()),
            _ => None,
        })
        .collect();
    assert_eq!(values, vec![b"token-abc".to_vec()]);

    // Another region's relay registers a computer; DNS points at that region.
    let other = "bbbbbbbbbbbbbbbb";
    let body =
        json!({"id": other, "region": "eu", "local": [], "txt": null, "online": true}).to_string();
    let (code, _) = env
        .http(
            "POST",
            "/v1/registry",
            "authorization: Bearer wrong\r\n",
            &body,
        )
        .await;
    assert_eq!(code, 401);
    let (code, _) = env
        .http(
            "POST",
            "/v1/registry",
            "authorization: Bearer s3cret\r\n",
            &body,
        )
        .await;
    assert_eq!(code, 200);
    assert_eq!(
        a_records(&a(format!("{other}.{D}.")).await),
        vec![Ipv4Addr::new(198, 51, 100, 7)]
    );

    // A relay's ACME challenge for its own name; other names are refused.
    let acme = |name: String| json!({"name": name, "values": ["relay-token"]}).to_string();
    let auth = "authorization: Bearer s3cret\r\n";
    let (code, _) = env
        .http(
            "POST",
            "/v1/registry/acme",
            auth,
            &acme(format!("_acme-challenge.{id}.{D}")),
        )
        .await;
    assert_eq!(code, 400);
    let (code, _) = env
        .http(
            "POST",
            "/v1/registry/acme",
            "",
            &acme(format!("_acme-challenge.eu.relay.{D}")),
        )
        .await;
    assert_eq!(code, 401);
    let (code, _) = env
        .http(
            "POST",
            "/v1/registry/acme",
            auth,
            &acme(format!("_acme-challenge.eu.relay.{D}")),
        )
        .await;
    assert_eq!(code, 200);
    let txt = dns_query(
        env.dns(),
        format!("_acme-challenge.eu.relay.{D}."),
        RecordType::TXT,
        false,
    )
    .await;
    assert_eq!(txt.answers.len(), 1);
}

#[tokio::test]
async fn txt_values_are_limited_to_what_acme_needs() {
    let env = Env::start(&["--dns", "127.0.0.1:0", "--registry-secret", "s3cret"]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    // ACME values are 43 characters; a wildcard and its base name need two.
    let value = "a".repeat(43);
    let cases = [
        (json!([value, value]), "ok"),
        (json!([value, value, value]), "error"),
        (json!(["a".repeat(65)]), "error"),
        (json!(["a".repeat(64)]), "ok"),
    ];
    for (i, (values, want)) in cases.into_iter().enumerate() {
        let req = i.to_string();
        agent
            .send(json!({"t": "txt", "req": req, "values": values}))
            .await;
        let answer = agent.next().await;
        assert_eq!(answer["t"], want, "{values}");
        assert_eq!(answer["req"], req.as_str());
    }

    let auth = "authorization: Bearer s3cret\r\n";
    let update = |txt: Value| {
        json!({"id": "bbbbbbbbbbbbbbbb", "region": "us", "local": [], "txt": txt, "online": true})
            .to_string()
    };
    let env = &env;
    let post = |body: String| async move { env.http("POST", "/v1/registry", auth, &body).await.0 };
    assert_eq!(post(update(json!(["x", "y", "z"]))).await, 400);
    assert_eq!(post(update(json!(["a".repeat(65)]))).await, 400);
    assert_eq!(post(update(json!(["x", "y"]))).await, 200);
    let acme = json!({"name": format!("_acme-challenge.us.relay.{D}"), "values": ["x", "y", "z"]});
    let (code, _) = env
        .http("POST", "/v1/registry/acme", auth, &acme.to_string())
        .await;
    assert_eq!(code, 400);
}

#[tokio::test]
async fn an_unsigned_acme_post_is_refused_before_its_body_arrives() {
    let env = Env::start(&["--registry-secret", "s3cret"]).await;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    // A stale MAC, and a fresh one announcing a body far larger than any challenge post:
    // neither waits for the 4 MB that never comes.
    for (auth, length) in [
        (format!("Pane-HMAC {} x", now - 3_600), 100),
        (format!("Pane-HMAC {now} x"), 4 * 1024 * 1024),
    ] {
        let mut s = env.connect_relay(D).await;
        let head = format!(
            "POST /v1/registry/acme HTTP/1.1\r\nhost: {D}\r\nauthorization: {auth}\r\ncontent-length: {length}\r\n\r\n"
        );
        s.write_all(head.as_bytes()).await.unwrap();
        let mut out = vec![0u8; 12];
        tokio::time::timeout(Duration::from_secs(2), s.read_exact(&mut out))
            .await
            .expect("answered without waiting for the body")
            .unwrap();
        let status = String::from_utf8_lossy(&out[9..12]).to_string();
        assert!(status == "401" || status == "413", "{auth}: {status}");
    }
}

#[tokio::test]
async fn udp_answers_past_the_rate_limit_are_truncated() {
    let env = Env::start(&[
        "--dns",
        "127.0.0.1:0",
        "--public-ip",
        "203.0.113.10",
        "--dns-responses-per-sec",
        "3",
    ])
    .await;
    let name = format!("{D}.");
    let mut truncated = 0;
    for _ in 0..6 {
        let m = dns_query(env.dns(), name.clone(), RecordType::A, false).await;
        if m.metadata.truncation {
            assert!(m.answers.is_empty());
            truncated += 1;
        } else {
            assert_eq!(a_records(&m), vec![Ipv4Addr::new(203, 0, 113, 10)]);
        }
    }
    // Six queries well inside one second: three answered, three truncated
    // (a test that straddles a second boundary answers more).
    assert!((1..=3).contains(&truncated), "{truncated} truncated");
    // TCP, where the source address is real, still answers in full.
    let m = dns_query(env.dns(), name, RecordType::A, true).await;
    assert!(!m.metadata.truncation);
    assert_eq!(a_records(&m), vec![Ipv4Addr::new(203, 0, 113, 10)]);
}

/// Polls `server` until the registry knows `name`, then returns its addresses: a name the
/// registry doesn't know answers this relay's address for 10 s.
async fn resolves(server: SocketAddr, name: String) -> Vec<Ipv4Addr> {
    let deadline = Instant::now() + WAIT;
    loop {
        let m = dns_query(server, name.clone(), RecordType::A, false).await;
        let known = m.answers.first().is_some_and(|r| r.ttl == 60);
        if known || Instant::now() > deadline {
            return a_records(&m);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn helper(region: &str) -> Env {
    Env::start(&[
        "--region",
        region,
        "--dns",
        "127.0.0.1:0",
        "--public-ip",
        "203.0.113.10",
        "--region-ip",
        "us=203.0.113.10,eu=198.51.100.7,ap=192.0.2.44",
        "--ns-ip",
        "ns1=203.0.113.10,ns2=198.51.100.7",
        "--registry-secret",
        "s3cret",
    ])
    .await
}

#[tokio::test]
async fn two_helpers_answer_for_a_computer_on_a_third_region() {
    let (us, eu) = (helper("us").await, helper("eu").await);
    let registry = |env: &Env| format!("https://127.0.0.1:{}/v1/registry", env.addr().port());
    let urls = format!("{},{}", registry(&us), registry(&eu));
    let ap = Env::start(&[
        "--region",
        "ap",
        "--registry-url",
        &urls,
        "--registry-secret",
        "s3cret",
        "--provider-ca",
        "{dir}/cert.pem",
    ])
    .await;
    let agent = Agent::connect(&ap, &SigningKey::generate()).await;

    let ap_ip = Ipv4Addr::new(192, 0, 2, 44);
    for helper in [&us, &eu] {
        assert_eq!(
            resolves(helper.dns(), format!("{}.{D}.", agent.id)).await,
            vec![ap_ip]
        );
        // Both answer the same NS set with glue-matching addresses.
        let ns = dns_query(helper.dns(), format!("{D}."), RecordType::NS, false).await;
        assert_eq!(ns.answers.len(), 2);
        assert_eq!(
            resolves(helper.dns(), format!("ns2.{D}.")).await,
            vec![Ipv4Addr::new(198, 51, 100, 7)]
        );
    }
}

/// Opens one client connection to `host` from `addr` and reports how it went.
async fn timed(agent: &Agent, addr: SocketAddr, host: &str) -> Result<Duration, ()> {
    let started = Instant::now();
    match agent.exchange_from(addr, host).await {
        Ok(answer) if answer == format!("{host} ping\n") => Ok(started.elapsed()),
        _ => Err(()),
    }
}

/// The computer is still connected: it gets a pong, not a close.
async fn still_connected(agent: &mut Agent) {
    agent.send(json!({"t": "ping"})).await;
    assert_eq!(agent.next().await, json!({"t": "pong"}));
}

const SLOWED: Duration = Duration::from_millis(900);

/// A fake registry helper over plain http. It sends each request's body to the returned
/// channel as it arrives, then replies 200 after `delay`, or never without one.
async fn fake_helper(delay: Option<Duration>) -> (String, mpsc::UnboundedReceiver<Value>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://127.0.0.1:{}/v1/registry",
        listener.local_addr().unwrap().port()
    );
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let tx = tx.clone();
            tokio::spawn(async move {
                let head = read_head(&mut tcp).await.to_ascii_lowercase();
                // Other local programs probe loopback ports; only the relay POSTs.
                if !head.starts_with("post ") {
                    return;
                }
                let len: usize = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length: "))
                    .map_or(0, |n| n.trim().parse().unwrap());
                let mut body = vec![0u8; len];
                tcp.read_exact(&mut body).await.unwrap();
                let _ = tx.send(serde_json::from_slice(&body).unwrap());
                tokio::time::sleep(delay.unwrap_or(Duration::from_secs(3600))).await;
                let ok = "HTTP/1.1 200 OK\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{\"ok\":true}";
                let _ = tcp.write_all(ok.as_bytes()).await;
            });
        }
    });
    (url, rx)
}

#[tokio::test]
async fn the_resync_posts_every_computer_to_a_helper_in_one_request() {
    let (url, mut posts) = fake_helper(Some(Duration::ZERO)).await;
    let env = Env::start(&[
        "--registry-url",
        &url,
        "--registry-resync-secs",
        "1",
        "--limit-agent-conns-per-min",
        "1000",
        "--limit-new-ids-per-hour",
        "1000",
    ])
    .await;
    let mut agents = Vec::new();
    for _ in 0..100 {
        agents.push(Agent::connect(&env, &SigningKey::generate()).await);
    }
    let mut ids: Vec<String> = agents.iter().map(|a| a.id.clone()).collect();
    ids.sort();

    let deadline = Instant::now() + WAIT;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let body = tokio::time::timeout(left, posts.recv())
            .await
            .expect("a request with every computer")
            .unwrap();
        let mut posted: Vec<String> = body
            .as_array()
            .into_iter()
            .flatten()
            .map(|u| u["id"].as_str().unwrap().to_string())
            .collect();
        posted.sort();
        if posted == ids {
            break;
        }
    }
}

#[tokio::test]
async fn a_txt_update_succeeds_when_one_helper_never_answers() {
    let (silent, _) = fake_helper(None).await;
    let (healthy, _) = fake_helper(Some(Duration::ZERO)).await;
    let env = Env::start(&["--registry-url", &format!("{silent},{healthy}")]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let started = Instant::now();
    agent
        .send(json!({"t": "txt", "req": "1", "values": ["token-abc"]}))
        .await;
    assert_eq!(agent.next().await, json!({"t": "ok", "req": "1"}));
    // The computer gives up after 20 s; the healthy helper answers at once.
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn an_acme_challenge_waits_for_a_slower_helper() {
    use pane_relay::registry::{AcmeTxt, Registry};
    // A relay near one helper and far from the other: the CA may ask either.
    let (near, _) = fake_helper(Some(Duration::ZERO)).await;
    let (far, _) = fake_helper(Some(Duration::from_millis(700))).await;
    let client = Registry::new(&[near, far], Some("s3cret".into()), None, 10).unwrap();
    let started = Instant::now();
    let challenge = AcmeTxt {
        name: format!("_acme-challenge.{D}"),
        values: vec!["token-1".into()],
    };
    client.publish_acme(challenge).await.unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(700),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_txt_update_goes_out_ahead_of_a_queued_resync() {
    // A slow helper keeps a resync of every computer waiting in the queue.
    let (url, mut posts) = fake_helper(Some(Duration::from_secs(2))).await;
    let env = Env::start(&[
        "--registry-url",
        &url,
        "--registry-resync-secs",
        "1",
        "--limit-agent-conns-per-min",
        "1000",
        "--limit-new-ids-per-hour",
        "1000",
    ])
    .await;
    let mut agents = Vec::new();
    for _ in 0..30 {
        agents.push(Agent::connect(&env, &SigningKey::generate()).await);
    }
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let agent = &mut agents[0];
    agent
        .send(json!({"t": "txt", "req": "1", "values": ["token-abc"]}))
        .await;

    // The request carrying the TXT value holds that update alone, not the resync's 30.
    let deadline = Instant::now() + Duration::from_secs(10);
    let body = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let body = tokio::time::timeout(left, posts.recv())
            .await
            .expect("the TXT update reached the helper")
            .unwrap();
        if body.to_string().contains("token-abc") {
            break body;
        }
    };
    let ids: Vec<&str> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![agent.id.as_str()]);
}

#[tokio::test]
async fn a_helper_that_never_answers_does_not_delay_the_blocklist() {
    let (url, _posts) = fake_helper(None).await;
    let env = Env::start(&[
        "--registry-url",
        &url,
        "--registry-resync-secs",
        "1",
        "--blocklist",
        "{dir}/blocked.txt",
    ])
    .await;
    let mut agents = Vec::new();
    for _ in 0..5 {
        agents.push(Agent::connect(&env, &SigningKey::generate()).await);
    }
    // Let a resync start against the silent helper (the first comes with the
    // 5 s maintenance tick), then block one computer.
    tokio::time::sleep(Duration::from_secs(6)).await;
    let id = agents[0].id.clone();
    std::fs::write(env.dir.join("blocked.txt"), format!("{id}\n")).unwrap();
    // The 5 s blocklist poll cuts it off.
    let deadline = Instant::now() + Duration::from_secs(8);
    while env.status(&id).await["state"] != "offline" {
        assert!(Instant::now() < deadline, "the blocklist was not applied");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Connects with `key` and returns the refusal's code, or "welcome".
async fn connect_code(env: &Env, key: &SigningKey) -> String {
    match Agent::try_connect(env, key, Sign::Correctly).await {
        Ok(_) => "welcome".into(),
        Err(e) => e["code"].as_str().unwrap().into(),
    }
}

#[tokio::test]
async fn new_computers_are_capped_per_address_and_in_total() {
    let env = Env::start(&["--limit-new-ids-per-hour", "2"]).await;
    let keys: Vec<SigningKey> = (0..3).map(|_| SigningKey::generate()).collect();
    assert_eq!(connect_code(&env, &keys[0]).await, "welcome");
    assert_eq!(connect_code(&env, &keys[1]).await, "welcome");
    assert_eq!(connect_code(&env, &keys[2]).await, "over-limit");
    // A computer the relay already knows still connects.
    assert_eq!(connect_code(&env, &keys[0]).await, "welcome");

    let env = Env::start(&["--max-computers", "1"]).await;
    assert_eq!(connect_code(&env, &keys[0]).await, "welcome");
    assert_eq!(connect_code(&env, &keys[1]).await, "full");
    assert_eq!(connect_code(&env, &keys[0]).await, "welcome");
}

/// Waits until the relay reports `id` with `state`.
async fn wait_state(env: &Env, id: &str, state: &str) {
    let deadline = Instant::now() + WAIT;
    while env.status(id).await["state"] != state {
        assert!(Instant::now() < deadline, "{id} never went {state}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_full_registry_makes_room_by_forgetting_its_oldest_offline_computer() {
    let env = Env::start(&[
        "--max-computers",
        "3",
        "--dns",
        "127.0.0.1:0",
        "--public-ip",
        "203.0.113.10",
    ])
    .await;
    let env = &env;
    // A name the registry knows answers for 60 s; a forgotten one answers this relay for 10 s.
    let known = |id: String| async move {
        let m = dns_query(env.dns(), format!("{id}.{D}."), RecordType::A, false).await;
        m.answers[0].ttl == 60
    };
    let oldest = Agent::connect(env, &SigningKey::generate()).await;
    let older = Agent::connect(env, &SigningKey::generate()).await;
    let (oldest_id, older_id) = (oldest.id.clone(), older.id.clone());
    oldest.close().await;
    wait_state(env, &oldest_id, "offline").await;
    older.close().await;
    wait_state(env, &older_id, "offline").await;
    let _online = Agent::connect(env, &SigningKey::generate()).await;

    // Full: a new computer takes the place of the one offline longest.
    let _new = Agent::connect(env, &SigningKey::generate()).await;
    assert!(!known(oldest_id.clone()).await);
    assert!(known(older_id.clone()).await);
    let _newer = Agent::connect(env, &SigningKey::generate()).await;
    assert!(!known(older_id).await);

    // Every entry online: refused.
    assert_eq!(connect_code(env, &SigningKey::generate()).await, "full");
}

#[tokio::test]
async fn computers_that_never_set_txt_are_forgotten_soon_after_going_offline() {
    let env = Env::start(&[
        "--dns",
        "127.0.0.1:0",
        "--public-ip",
        "203.0.113.10",
        "--unproven-ttl-secs",
        "1",
    ])
    .await;
    let mut proven = Agent::connect(&env, &SigningKey::generate()).await;
    proven
        .send(json!({"t": "txt", "req": "1", "values": ["token-abc"]}))
        .await;
    assert_eq!(proven.next().await, json!({"t": "ok", "req": "1"}));
    let unproven = Agent::connect(&env, &SigningKey::generate()).await;
    let (proven_id, unproven_id) = (proven.id.clone(), unproven.id.clone());
    proven.close().await;
    unproven.close().await;

    let deadline = Instant::now() + Duration::from_secs(10);
    while !env.status(&unproven_id).await["since"].is_null() {
        assert!(Instant::now() < deadline, "a computer with no TXT was kept");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert!(!env.status(&proven_id).await["since"].is_null());
}

#[tokio::test]
async fn control_connections_are_slowed_then_refused_per_address() {
    let env = Env::start(&["--limit-agent-conns-per-min", "2"]).await;
    let key = SigningKey::generate();
    for _ in 0..2 {
        let started = Instant::now();
        assert_eq!(connect_code(&env, &key).await, "welcome");
        assert!(started.elapsed() < SLOWED);
    }
    for _ in 0..2 {
        let started = Instant::now();
        assert_eq!(connect_code(&env, &key).await, "welcome");
        assert!(started.elapsed() >= SLOWED);
    }
    assert_eq!(connect_code(&env, &key).await, "over-limit");
}

/// The TXT values DNS answers for `name`.
async fn txt_values(server: SocketAddr, name: String) -> Vec<Vec<u8>> {
    let m = dns_query(server, name, RecordType::TXT, false).await;
    m.answers
        .iter()
        .filter_map(|r| match &r.data {
            RData::TXT(t) => Some(t.txt_data.concat()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn offline_computers_lose_their_txt_values_then_their_names() {
    let env = Env::start(&[
        "--dns",
        "127.0.0.1:0",
        "--public-ip",
        "203.0.113.10",
        "--txt-ttl-secs",
        "1",
        "--registry-ttl-secs",
        "8",
    ])
    .await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let id = agent.id.clone();
    agent
        .send(json!({"t": "txt", "req": "1", "values": ["token-abc"]}))
        .await;
    assert_eq!(agent.next().await, json!({"t": "ok", "req": "1"}));
    let txt_name = format!("_acme-challenge.{id}.{D}.");
    assert_eq!(
        txt_values(env.dns(), txt_name.clone()).await,
        vec![b"token-abc".to_vec()]
    );
    // The connection closes once the test agent's reader also gives up (5 s).
    drop(agent);

    // The TXT values go first; the name still resolves.
    let deadline = Instant::now() + Duration::from_secs(15);
    while !txt_values(env.dns(), txt_name.clone()).await.is_empty() {
        assert!(Instant::now() < deadline, "TXT values were kept offline");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    let a = || dns_query(env.dns(), format!("{id}.{D}."), RecordType::A, false);
    assert_eq!(a_records(&a().await), vec![Ipv4Addr::new(203, 0, 113, 10)]);

    // Then the whole entry and its status; its name answers like an unknown computer's.
    let deadline = Instant::now() + Duration::from_secs(16);
    while !env.status(&id).await["since"].is_null() {
        assert!(
            Instant::now() < deadline,
            "offline computer was never forgotten"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(env.status(&id).await["state"], "offline");
    assert_eq!(a().await.answers[0].ttl, 10);
}

#[tokio::test]
async fn a_flood_from_one_address_slows_then_refuses_only_that_address() {
    let env = Env::start(&["--listen", "[::]:0", "--limit-conns-per-min", "2"]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let host = format!("{}.{D}", agent.id);

    // Up to the limit: straight through. Up to twice it: slowed. Past that: refused.
    for _ in 0..2 {
        assert!(timed(&agent, env.addr(), &host).await.unwrap() < SLOWED);
    }
    for _ in 0..2 {
        assert!(timed(&agent, env.addr(), &host).await.unwrap() >= SLOWED);
    }
    assert!(timed(&agent, env.addr(), &host).await.is_err());

    // The computer stays connected, and another address still reaches it at full speed.
    still_connected(&mut agent).await;
    assert!(timed(&agent, env.addr_v6(), &host).await.unwrap() < SLOWED);
}

#[tokio::test]
async fn one_address_has_a_limit_across_all_computers() {
    let env = Env::start(&["--listen", "[::]:0", "--limit-ip-conns-per-min", "2"]).await;
    let mut a = Agent::connect(&env, &SigningKey::generate()).await;
    let mut b = Agent::connect(&env, &SigningKey::generate()).await;
    let (host_a, host_b) = (format!("{}.{D}", a.id), format!("{}.{D}", b.id));

    for _ in 0..2 {
        assert!(timed(&a, env.addr(), &host_a).await.unwrap() < SLOWED);
    }
    // B is new to this address, but the address is past its own limit.
    for _ in 0..2 {
        assert!(timed(&b, env.addr(), &host_b).await.unwrap() >= SLOWED);
    }
    assert!(timed(&b, env.addr(), &host_b).await.is_err());

    still_connected(&mut a).await;
    still_connected(&mut b).await;
    assert!(timed(&b, env.addr_v6(), &host_b).await.unwrap() < SLOWED);
}

#[tokio::test]
async fn connections_for_a_computer_that_is_not_here_count_against_their_address() {
    let env = Env::start(&["--listen", "[::]:0", "--limit-ip-conns-per-min", "2"]).await;
    let agent = Agent::connect(&env, &SigningKey::generate()).await;
    let host = format!("{}.{D}", agent.id);

    // A Pane retrying a computer that is gone: each attempt is refused, and each one counts.
    for _ in 0..4 {
        assert!(
            timed(&agent, env.addr(), &format!("aaaaaaaaaaaaaaaa.{D}"))
                .await
                .is_err()
        );
    }
    assert!(timed(&agent, env.addr(), &host).await.is_err());
    assert!(timed(&agent, env.addr_v6(), &host).await.unwrap() < SLOWED);
}

#[tokio::test]
async fn an_upload_past_the_rate_is_slowed_and_never_closed() {
    // 8 Mbit/s is 1 MB a second, with one second's worth to start.
    let env = Env::start(&["--listen", "[::]:0", "--limit-mbit-per-sec", "8"]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let host = format!("{}.{D}", agent.id);

    let big = agent.upload(env.addr(), &host, 4_000_000);
    // Another address, while the first is held to its rate, goes at full speed.
    let other = async {
        tokio::time::sleep(Duration::from_millis(500)).await;
        agent.upload(env.addr_v6(), &host, 800_000).await
    };
    let (big, other) = tokio::join!(big, other);
    let (answer, took) = big.unwrap();
    assert_eq!(answer, format!("{host} got 4000000\n"));
    // 3 MB past the first second's worth, at 1 MB a second.
    assert!(took >= Duration::from_millis(2_700), "{took:?}");
    let (answer, took) = other.unwrap();
    assert_eq!(answer, format!("{host} got 800000\n"));
    assert!(took < Duration::from_millis(500), "{took:?}");
    still_connected(&mut agent).await;
}

#[tokio::test]
async fn one_address_has_a_rate_across_all_computers() {
    let env = Env::start(&["--limit-ip-mbit-per-sec", "8"]).await;
    let a = Agent::connect(&env, &SigningKey::generate()).await;
    let b = Agent::connect(&env, &SigningKey::generate()).await;
    let (host_a, host_b) = (format!("{}.{D}", a.id), format!("{}.{D}", b.id));

    let started = std::time::Instant::now();
    let (to_a, to_b) = tokio::join!(
        a.upload(env.addr(), &host_a, 2_000_000),
        b.upload(env.addr(), &host_b, 2_000_000),
    );
    assert_eq!(to_a.unwrap().0, format!("{host_a} got 2000000\n"));
    assert_eq!(to_b.unwrap().0, format!("{host_b} got 2000000\n"));
    assert!(
        started.elapsed() >= Duration::from_millis(2_700),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_computer_flooding_its_control_connection_is_cut_off() {
    let env = Env::start(&[]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    // More than twice the 600 frames a minute.
    for _ in 0..1201 {
        agent.send(json!({"t": "ping"})).await;
    }
    let close = loop {
        let frame = agent.next().await;
        if frame["t"] != "pong" {
            break frame;
        }
    };
    assert_eq!(
        (close["t"].as_str(), close["code"].as_str()),
        (Some("close"), Some("over-limit"))
    );
}

/// One request a fake push provider received.
struct Received {
    path: String,
    headers: http::HeaderMap,
    body: Vec<u8>,
}

type Respond = Arc<dyn Fn(&str, &[u8]) -> (u16, String) + Send + Sync>;

/// A fake push provider: HTTP/2 over TLS on loopback with a self-signed certificate
/// written to `ca`, answering each request with `respond(path, body)`.
struct Provider {
    url: String,
    ca: PathBuf,
    received: mpsc::UnboundedReceiver<Received>,
}

impl Provider {
    async fn start(
        respond: impl Fn(&str, &[u8]) -> (u16, String) + Send + Sync + 'static,
    ) -> Provider {
        let respond: Respond = Arc::new(respond);
        let ck = rcgen::generate_simple_self_signed(vec!["127.0.0.1".to_string()]).unwrap();
        let ca = scratch_dir().join("provider.pem");
        std::fs::write(&ca, ck.cert.pem()).unwrap();
        let mut tls = rustls::ServerConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![ck.cert.der().clone()],
                PrivateKeyDer::try_from(ck.signing_key.serialize_der()).unwrap(),
            )
            .unwrap();
        tls.alpn_protocols = vec![b"h2".to_vec()];
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(tls));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "https://127.0.0.1:{}",
            listener.local_addr().unwrap().port()
        );
        let (tx, received) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let (acceptor, respond, tx) = (acceptor.clone(), respond.clone(), tx.clone());
                tokio::spawn(async move {
                    let tls = acceptor.accept(tcp).await.unwrap();
                    let mut conn = h2::server::handshake(tls).await.unwrap();
                    while let Some(Ok((req, mut answer))) = conn.accept().await {
                        let (respond, tx) = (respond.clone(), tx.clone());
                        tokio::spawn(async move {
                            let (parts, mut body) = req.into_parts();
                            let mut bytes = Vec::new();
                            while let Some(chunk) = body.data().await {
                                let chunk = chunk.unwrap();
                                let _ = body.flow_control().release_capacity(chunk.len());
                                bytes.extend_from_slice(&chunk);
                            }
                            let path = parts.uri.path().to_string();
                            let (status, text) = respond(&path, &bytes);
                            let _ = tx.send(Received {
                                path,
                                headers: parts.headers,
                                body: bytes,
                            });
                            let head = http::Response::builder().status(status).body(()).unwrap();
                            let mut stream = answer.send_response(head, false).unwrap();
                            stream.send_data(bytes::Bytes::from(text), true).unwrap();
                        });
                    }
                });
            }
        });
        Provider { url, ca, received }
    }

    async fn next(&mut self) -> Received {
        tokio::time::timeout(WAIT, self.received.recv())
            .await
            .expect("provider request in time")
            .unwrap()
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.ca.parent().unwrap());
    }
}

fn header<'a>(r: &'a Received, name: &str) -> Option<&'a str> {
    r.headers.get(name).map(|v| v.to_str().unwrap())
}

/// Splits a JWT and returns its decoded header, claims, signing input and signature.
fn split_jwt(token: &str) -> (Value, Value, String, Vec<u8>) {
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3, "{token}");
    let decode = |s: &str| BASE64URL_NOPAD.decode(s.as_bytes()).unwrap();
    (
        serde_json::from_slice(&decode(parts[0])).unwrap(),
        serde_json::from_slice(&decode(parts[1])).unwrap(),
        format!("{}.{}", parts[0], parts[1]),
        decode(parts[2]),
    )
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// Asks the relay to send phone `token` a grant for `agent`, as a computer does when a phone
/// registers; returns the grant the phone receives and every request the provider got.
async fn grant(
    agent: &mut Agent,
    provider: &mut Provider,
    platform: &str,
    token: &str,
) -> (String, Vec<Received>) {
    agent
        .send(
            json!({"t": "grant", "req": "g", "platform": platform, "token": token,
            "hostProfileId": "h1"}),
        )
        .await;
    assert_eq!(agent.next().await["t"], "ok");
    let mut sent = vec![provider.next().await];
    while let Ok(r) = provider.received.try_recv() {
        sent.push(r);
    }
    let found = sent.iter().find_map(|r| {
        let body: Value = serde_json::from_slice(&r.body).ok()?;
        let g = match platform {
            "ios" => &body["paneGrant"],
            _ => &body["message"]["data"]["paneGrant"],
        };
        g.as_str().map(String::from)
    });
    (found.expect("a grant push"), sent)
}

/// Starts a relay with APNs keys pointing at `apns` (sandbox at `<url>/sandbox`); returns it
/// with the key the relay signs with.
async fn apns_env(apns: &Provider) -> (Env, SigningKey) {
    let kp = rcgen::KeyPair::generate().unwrap();
    let key_path = apns.ca.with_file_name("apns.p8");
    std::fs::write(&key_path, kp.serialize_pem()).unwrap();
    let sandbox = format!("{}/sandbox", apns.url);
    let env = Env::start(&[
        "--apns-key-path",
        key_path.to_str().unwrap(),
        "--apns-key-id",
        "KEY1234567",
        "--apns-team-id",
        "TEAM123456",
        "--apns-url",
        &apns.url,
        "--apns-sandbox-url",
        &sandbox,
        "--provider-ca",
        apns.ca.to_str().unwrap(),
    ])
    .await;
    (
        env,
        SigningKey::from_pkcs8_der(&kp.serialize_der()).unwrap(),
    )
}

#[tokio::test]
async fn ios_alerts_reach_apns_with_a_signed_provider_token() {
    let mut apns = Provider::start(|_, _| (200, String::new())).await;
    let (env, key) = apns_env(&apns).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;

    // The grant reaches the phone as a silent push it hands to this computer.
    let (g, sent) = grant(&mut agent, &mut apns, "ios", "abcdef0123").await;
    assert!(g.starts_with(&format!("{}.", agent.id)), "{g}");
    let r = &sent[0];
    assert_eq!(r.path, "/3/device/abcdef0123");
    assert_eq!(header(r, "apns-push-type"), Some("background"));
    assert_eq!(header(r, "apns-priority"), Some("5"));
    assert_eq!(
        serde_json::from_slice::<Value>(&r.body).unwrap(),
        json!({"aps": {"content-available": 1}, "paneGrant": g, "hostProfileId": "h1"})
    );

    // A Notify clear, as Pane sends it (mobilePushSender.ts).
    let payload = json!({"aps": {"content-available": 1}, "notifyClear": true,
        "eventId": "e1", "hostProfileId": "h1", "notifyId": "n1"});
    agent
        .send(
            json!({"t": "alert", "req": "7", "platform": "ios", "token": "abcdef0123",
            "pushType": "background", "collapseId": "session-1", "payload": payload, "grant": g}),
        )
        .await;
    assert_eq!(
        agent.next().await,
        json!({"t": "ok", "req": "7", "status": 200, "body": ""})
    );
    let r = apns.next().await;
    assert_eq!(r.path, "/3/device/abcdef0123");
    assert_eq!(header(&r, "apns-topic"), Some("com.dcouple.pane.mobile"));
    assert_eq!(header(&r, "apns-push-type"), Some("background"));
    assert_eq!(header(&r, "apns-priority"), Some("5"));
    assert_eq!(header(&r, "apns-collapse-id"), Some("session-1"));
    assert_eq!(serde_json::from_slice::<Value>(&r.body).unwrap(), payload);

    let token = header(&r, "authorization")
        .unwrap()
        .strip_prefix("bearer ")
        .unwrap();
    let (head, claims, input, sig) = split_jwt(token);
    assert_eq!(head, json!({"alg": "ES256", "kid": "KEY1234567"}));
    assert_eq!(claims["iss"], "TEAM123456");
    assert!((claims["iat"].as_i64().unwrap() - unix_now()).abs() < 60);
    let sig = p256::ecdsa::Signature::from_slice(&sig).unwrap();
    use p256::ecdsa::signature::Verifier;
    key.verifying_key().verify(input.as_bytes(), &sig).unwrap();

    // An alert push has the default priority and no collapse id, and reuses the token.
    agent
        .send(
            json!({"t": "alert", "req": "8", "platform": "ios", "token": "abcdef0123",
            "pushType": "alert", "payload": {"aps": {"alert": {"title": "Build", "body": "Build is blocked"}}},
            "grant": g}),
        )
        .await;
    assert_eq!(agent.next().await["t"], "ok");
    let r2 = apns.next().await;
    assert_eq!(header(&r2, "apns-push-type"), Some("alert"));
    assert_eq!(header(&r2, "apns-priority"), None);
    assert_eq!(header(&r2, "apns-collapse-id"), None);
    assert_eq!(header(&r2, "authorization"), header(&r, "authorization"));
}

#[tokio::test]
async fn bad_device_token_retries_the_apns_sandbox_once() {
    let mut apns = Provider::start(|path, _| match path {
        p if p.starts_with("/sandbox/") && p.ends_with("/dead") => {
            (410, r#"{"reason":"Unregistered"}"#.to_string())
        }
        p if p.starts_with("/sandbox/") => (200, String::new()),
        _ => (400, r#"{"reason":"BadDeviceToken"}"#.to_string()),
    })
    .await;
    let (env, _) = apns_env(&apns).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let (beef, _) = grant(&mut agent, &mut apns, "ios", "beef").await;
    let (dead, _) = grant(&mut agent, &mut apns, "ios", "dead").await;

    agent
        .send(
            json!({"t": "alert", "req": "1", "platform": "ios", "token": "beef",
            "pushType": "alert", "payload": {"aps": {}}, "grant": beef}),
        )
        .await;
    assert_eq!(
        agent.next().await,
        json!({"t": "ok", "req": "1", "status": 200, "body": ""})
    );
    assert_eq!(apns.next().await.path, "/3/device/beef");
    assert_eq!(apns.next().await.path, "/sandbox/3/device/beef");

    // The provider's refusal comes back as `ok` with its status and body.
    agent
        .send(
            json!({"t": "alert", "req": "2", "platform": "ios", "token": "dead",
            "pushType": "alert", "payload": {"aps": {}}, "grant": dead}),
        )
        .await;
    assert_eq!(
        agent.next().await,
        json!({"t": "ok", "req": "2", "status": 410, "body": r#"{"reason":"Unregistered"}"#})
    );
}

const FCM_KEY: &str = r"-----BEGIN PRIVATE KEY-----
MIIEuwIBADANBgkqhkiG9w0BAQEFAASCBKUwggShAgEAAoIBAQDbav2ROk/KqS7Y
7m7IUh2in5933pgk3i7tn4XmJtZ4MEKB499UD1rhThN5hv6Iv7+LItJ+mTsVhfQd
QKbendmLE8qCMlLghTXaYLctB9SGF8Ie8hGU/VDfx+ouUXXB/QPcwVHIW1+bsZ6w
WPdYs1vsoZfJiaFCLsBTS9lgdfbuCWgiLxHmGvM8hBag5nUT8c8b2AeNibaFuryE
Jnimq1gFdKSkx2Ro8p1VUQ3JWq5Jh3AP4M8KGeJX3f+Frv9LN3GladRzeEsab0zO
CrFACLsW9r6sV5kz2+BJAYEsFEEtLo7fHf5TCMp5fCeEP1O2cTX4mDL9U4cJGa3l
mBValddxAgMBAAECgf8XC7oGqQBjwXzx/qjBlSKHtlCQ6Yln8naDp1SzmghI0H8m
Qt4QBdaE3qRZNIR4ycTQ3PIo1Ue24iZvwcKw2hGIjM7TDAINuaK/bVTZM077OMI4
q+bWSlD2kcd0kzVjD/Yd4FUGy3LKXIftrpiHHN88j62xxEENWwQ7xoc0KTcYT5rk
KyIf47pHz5dHe5zyuduj5S/LtRX6xRpAxZ5F0gmHx6Iu2hXRJjx2To1YzCrTOxPw
/pdpyCLSooicYMGogZnRJYpmNtk6VYAmWfa7oZu0g0e6tRIskO+E8eFccX7M6ZZE
WQB2YFEFadNTq7shoUfu/I+zujtTMcZuTLI8ncMCgYEA728br9tEPZM4MQlnojnq
CIRW2+xq7IYDcv5agAFw89t0+IuHieo9sw48hDhHytHw7cz5K1ZI5wS8EA1crdf2
ePMxDjRif1HchV8ns8bKBYDIzyu/h3UZRmnzFB4aARwnUeCw3DyWr8vrau2smu7U
ZFgzNgCCAaF9bx1MqCwYHecCgYEA6plauefB0khZ9q3o65WhB6Jhs3Oe5/duYU/I
4bgrE6oC1nliSXViUVQYehiVgr+5iu5GZdb2ZARRd8xiep0aVup2giujNSHDOMZ/
I4HThSSO7V5CkiNXN9Q1MNh71wDIXrtOmAd57bqmtgUouSf5D1FWlaXardTGaOmg
EyzixOcCgYAlbtN/TOKAVfHlCLlhDXjfWAFUZMPasqD7a3SuqosENP02lmncT/jR
c5pWeY4P0X6/TtptwhGnvH/CarRgoXDxO+QhemMj0KKPX28PljajYZ0Ddq18+fu3
nHzaWlJqdgJXtK8x328XkOP/VaU0m74s6fUnrjClHKBFrOj9KdejZQKBgH+V62uT
iSuNwa+QoU4OUEdQnoXz6YYKYPN3aq6ndHX7ThPKbBO7TT8h1zX/zMAQ+R1/vLWC
FPoMByp580zvx/VhChZ9GQO6WuuzuE1dO+X7HegmDVpg8fwg4tSvx5oEiPRMNdAk
sMEDc8smPyGDhcY43DgCvU0wnL9N34rOLH4dAoGBALQ0PpYkPg6TZTyNIaZh3G3u
r1LvvFm7p9ZhRc93NdbkUgNS5qCeJJP43QVkdUARJ/7YHN2IR5MgqoNbXGTQ4jAB
5XWhBqACkvkVsOfkoU3S2ZgzxfhVQNbo0wFeAWy43inV2W3eCFu8ONT8NPPNLamd
SXWY4mwchNxCE1PQ96IH
-----END PRIVATE KEY-----
";

/// Starts a fake FCM (token endpoint at /token) and a relay using it.
async fn fcm_env(extra: &[&str]) -> (Env, Provider) {
    let fcm = Provider::start(|path, _| match path {
        "/token" => (
            200,
            r#"{"access_token":"ya29.test","expires_in":3600,"token_type":"Bearer"}"#.to_string(),
        ),
        "/v1/projects/pane-test/messages:send" => (
            200,
            r#"{"name":"projects/pane-test/messages/1"}"#.to_string(),
        ),
        _ => (404, String::new()),
    })
    .await;
    let sa = json!({"type": "service_account", "project_id": "pane-test",
        "private_key": FCM_KEY, "client_email": "sender@pane-test.iam.gserviceaccount.com",
        "token_uri": "https://oauth2.googleapis.com/token"});
    let sa_path = fcm.ca.with_file_name("sa.json");
    std::fs::write(&sa_path, sa.to_string()).unwrap();
    let token_url = format!("{}/token", fcm.url);
    let mut args = vec![
        "--fcm-service-account",
        sa_path.to_str().unwrap(),
        "--fcm-url",
        &fcm.url,
        "--fcm-token-url",
        &token_url,
        "--provider-ca",
        fcm.ca.to_str().unwrap(),
    ];
    args.extend_from_slice(extra);
    (Env::start(&args).await, fcm)
}

#[tokio::test]
async fn android_alerts_reach_fcm_with_an_access_token() {
    let (env, mut fcm) = fcm_env(&[]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let (g, sent) = grant(&mut agent, &mut fcm, "android", "fcm-device-token").await;

    let message = json!({"token": "fcm-device-token", "data": {"eventId": "e1", "notifyClear": "1"},
        "android": {"priority": "high"}});
    for req in ["1", "2"] {
        agent
            .send(
                json!({"t": "alert", "req": req, "platform": "android", "message": message,
                "grant": g}),
            )
            .await;
        assert_eq!(
            agent.next().await,
            json!({"t": "ok", "req": req, "status": 200,
                "body": r#"{"name":"projects/pane-test/messages/1"}"#})
        );
    }

    // One token request (cached for every later send), the grant push, then the two sends.
    let t = &sent[0];
    assert_eq!(t.path, "/token");
    let form = String::from_utf8(t.body.clone()).unwrap();
    let assertion = form
        .strip_prefix("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=")
        .unwrap();
    let (head, claims, input, sig) = split_jwt(assertion);
    assert_eq!(head["alg"], "RS256");
    assert_eq!(claims["iss"], "sender@pane-test.iam.gserviceaccount.com");
    assert_eq!(
        claims["scope"],
        "https://www.googleapis.com/auth/firebase.messaging"
    );
    assert_eq!(claims["aud"], format!("{}/token", fcm.url));
    assert_eq!(
        claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
        3600
    );
    let der = PrivateKeyDer::from_pem_slice(FCM_KEY.as_bytes()).unwrap();
    let kp = ring::signature::RsaKeyPair::from_pkcs8(der.secret_der()).unwrap();
    ring::signature::UnparsedPublicKey::new(
        &ring::signature::RSA_PKCS1_2048_8192_SHA256,
        kp.public().as_ref(),
    )
    .verify(input.as_bytes(), &sig)
    .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&sent[1].body).unwrap(),
        json!({"message": {"token": "fcm-device-token", "android": {"priority": "high"},
            "data": {"paneGrant": g, "hostProfileId": "h1"}}})
    );

    for _ in 0..2 {
        let send = fcm.next().await;
        assert_eq!(send.path, "/v1/projects/pane-test/messages:send");
        assert_eq!(header(&send, "authorization"), Some("Bearer ya29.test"));
        assert_eq!(
            serde_json::from_slice::<Value>(&send.body).unwrap(),
            json!({"message": message})
        );
    }
}

/// A fake GCE metadata server: answers token requests with an access token and
/// sends each request head to the returned channel.
async fn metadata_server() -> (String, mpsc::UnboundedReceiver<String>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://127.0.0.1:{}/computeMetadata/v1/instance/service-accounts/default/token",
        listener.local_addr().unwrap().port()
    );
    let (tx, rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            let head = read_head(&mut tcp).await;
            // Other local programs probe loopback ports; only the relay asks for this path.
            if !head.contains("/computeMetadata/") {
                continue;
            }
            let _ = tx.send(head);
            let body = r#"{"access_token":"ya29.keyless","expires_in":3599,"token_type":"Bearer"}"#;
            let reply = format!(
                "HTTP/1.0 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = tcp.write_all(reply.as_bytes()).await;
        }
    });
    (url, rx)
}

#[tokio::test]
async fn android_alerts_without_a_key_use_the_metadata_server_token() {
    let mut fcm = Provider::start(|path, _| match path {
        "/v1/projects/pane-keyless/messages:send" => (200, "{}".to_string()),
        _ => (404, String::new()),
    })
    .await;
    let (metadata_url, mut metadata) = metadata_server().await;
    let env = Env::start(&[
        "--fcm-project",
        "pane-keyless",
        "--metadata-url",
        &metadata_url,
        "--fcm-url",
        &fcm.url,
        "--provider-ca",
        fcm.ca.to_str().unwrap(),
    ])
    .await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let (g, _) = grant(&mut agent, &mut fcm, "android", "fcm-device-token").await;
    for req in ["1", "2"] {
        agent
            .send(json!({"t": "alert", "req": req, "platform": "android",
                "message": {"token": "fcm-device-token", "data": {}}, "grant": g}))
            .await;
        assert_eq!(agent.next().await["status"], 200);
    }

    // One metadata request (the token is cached for the alerts).
    let head = tokio::time::timeout(WAIT, metadata.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        head.starts_with("GET /computeMetadata/v1/instance/service-accounts/default/token HTTP/1."),
        "{head}"
    );
    assert!(
        head.to_ascii_lowercase()
            .contains("metadata-flavor: google"),
        "{head}"
    );
    assert!(metadata.try_recv().is_err());
    for _ in 0..2 {
        let send = fcm.next().await;
        assert_eq!(send.path, "/v1/projects/pane-keyless/messages:send");
        assert_eq!(header(&send, "authorization"), Some("Bearer ya29.keyless"));
    }
}

#[tokio::test]
async fn alerts_past_the_hourly_limit_are_throttled() {
    let (env, mut fcm) = fcm_env(&["--limit-alerts-per-hour", "2"]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let (g, _) = grant(&mut agent, &mut fcm, "android", "fcm-device-token").await;
    let alert = |req: &str| {
        json!({"t": "alert", "req": req, "platform": "android",
        "message": {"token": "fcm-device-token", "data": {}}, "grant": g})
    };
    for req in ["1", "2"] {
        agent.send(alert(req)).await;
        assert_eq!(agent.next().await["t"], "ok");
    }
    agent.send(alert("3")).await;
    let answer = agent.next().await;
    assert_eq!(
        (answer["req"].as_str(), answer["code"].as_str()),
        (Some("3"), Some("throttled"))
    );

    // Two sends; the throttled alert never reached FCM.
    for _ in 0..2 {
        fcm.next().await;
    }
    assert!(fcm.received.try_recv().is_err());
}

#[tokio::test]
async fn alerts_to_one_device_are_capped_across_computers() {
    let (env, mut fcm) = fcm_env(&["--limit-alerts-per-token-per-hour", "2"]).await;
    let mut a = Agent::connect(&env, &SigningKey::generate()).await;
    let mut b = Agent::connect(&env, &SigningKey::generate()).await;
    let (a1, _) = grant(&mut a, &mut fcm, "android", "phone-1").await;
    let (b1, _) = grant(&mut b, &mut fcm, "android", "phone-1").await;
    let (b2, _) = grant(&mut b, &mut fcm, "android", "phone-2").await;
    let alert = |req: &str, token: &str, grant: &str| {
        json!({"t": "alert", "req": req, "platform": "android",
        "message": {"token": token, "data": {"eventId": "e1"}}, "grant": grant})
    };
    for req in ["1", "2"] {
        a.send(alert(req, "phone-1", &a1)).await;
        assert_eq!(a.next().await["t"], "ok");
    }
    // Another computer, same phone: over the phone's limit.
    b.send(alert("3", "phone-1", &b1)).await;
    assert_eq!(b.next().await["code"], "throttled");
    b.send(alert("4", "phone-2", &b2)).await;
    assert_eq!(b.next().await["t"], "ok");
}

#[tokio::test]
async fn alerts_need_the_grant_the_phone_received_for_that_computer() {
    let (env, mut fcm) = fcm_env(&[]).await;
    let mut a = Agent::connect(&env, &SigningKey::generate()).await;
    let mut b = Agent::connect(&env, &SigningKey::generate()).await;
    let alert = |token: &str, grant: Option<&str>| {
        let mut v = json!({"t": "alert", "req": "1", "platform": "android",
            "message": {"token": token, "data": {"eventId": "e1"}}});
        if let Some(g) = grant {
            v["grant"] = json!(g);
        }
        v
    };

    // No grant yet: refused before anything reaches FCM.
    a.send(alert("phone-1", None)).await;
    assert_eq!(a.next().await["code"], "unbound");
    assert!(fcm.received.try_recv().is_err());

    let (g, _) = grant(&mut a, &mut fcm, "android", "phone-1").await;
    a.send(alert("phone-1", Some(&g))).await;
    assert_eq!(a.next().await["t"], "ok");

    // A grant works only for the computer and the phone it names.
    let at = g.rfind('.').unwrap() + 1;
    let flipped = if &g[at..=at] == "A" { "B" } else { "A" };
    let forged = format!("{}{flipped}{}", &g[..at], &g[at + 1..]);
    b.send(alert("phone-1", Some(&g))).await;
    assert_eq!(b.next().await["code"], "unbound");
    for (token, grant) in [
        ("phone-2", g.as_str()),
        ("phone-1", &forged),
        ("phone-1", "garbage"),
    ] {
        a.send(alert(token, Some(grant))).await;
        assert_eq!(a.next().await["code"], "unbound", "{token} {grant}");
    }
}

#[tokio::test]
async fn a_grant_is_good_only_for_the_platform_it_names() {
    // One fake provider answers for both APNs and FCM.
    let mut both = Provider::start(|path, _| match path {
        "/token" => (
            200,
            r#"{"access_token":"ya29.test","expires_in":3600}"#.to_string(),
        ),
        _ => (200, "{}".to_string()),
    })
    .await;
    let kp = rcgen::KeyPair::generate().unwrap();
    let key_path = both.ca.with_file_name("apns.p8");
    std::fs::write(&key_path, kp.serialize_pem()).unwrap();
    let sa = json!({"type": "service_account", "project_id": "pane-test",
        "private_key": FCM_KEY, "client_email": "sender@pane-test.iam.gserviceaccount.com"});
    let sa_path = both.ca.with_file_name("sa.json");
    std::fs::write(&sa_path, sa.to_string()).unwrap();
    let token_url = format!("{}/token", both.url);
    let env = Env::start(&[
        "--apns-key-path",
        key_path.to_str().unwrap(),
        "--apns-key-id",
        "KEY1234567",
        "--apns-team-id",
        "TEAM123456",
        "--apns-url",
        &both.url,
        "--fcm-service-account",
        sa_path.to_str().unwrap(),
        "--fcm-url",
        &both.url,
        "--fcm-token-url",
        &token_url,
        "--provider-ca",
        both.ca.to_str().unwrap(),
    ])
    .await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;

    // A hex token is valid on both platforms; the Android grant must not work for iOS.
    let (g, _) = grant(&mut agent, &mut both, "android", "abcdef01").await;
    agent
        .send(
            json!({"t": "alert", "req": "1", "platform": "ios", "token": "abcdef01",
            "pushType": "alert", "payload": {"aps": {}}, "grant": g}),
        )
        .await;
    assert_eq!(agent.next().await["code"], "unbound");
    agent
        .send(json!({"t": "alert", "req": "2", "platform": "android",
            "message": {"token": "abcdef01", "data": {}}, "grant": g}))
        .await;
    assert_eq!(agent.next().await["t"], "ok");
}

#[tokio::test]
async fn grants_hold_on_every_relay_that_shares_the_registry_secret() {
    let key = SigningKey::generate();
    let (first, mut fcm) = fcm_env(&["--registry-secret", "shared"]).await;
    let mut agent = Agent::connect(&first, &key).await;
    let (g, _) = grant(&mut agent, &mut fcm, "android", "phone-1").await;
    let alert = json!({"t": "alert", "req": "1", "platform": "android",
        "message": {"token": "phone-1", "data": {}}, "grant": g});

    // The computer moves to another region's relay.
    let (second, _fcm2) = fcm_env(&["--registry-secret", "shared"]).await;
    let mut moved = Agent::connect(&second, &key).await;
    moved.send(alert.clone()).await;
    assert_eq!(moved.next().await["t"], "ok");

    let (other, _fcm3) = fcm_env(&["--registry-secret", "other"]).await;
    let mut elsewhere = Agent::connect(&other, &key).await;
    elsewhere.send(alert).await;
    assert_eq!(elsewhere.next().await["code"], "unbound");
}

#[tokio::test]
async fn grant_pushes_are_capped_per_computer_and_phone_apart_from_alerts() {
    let (env, mut fcm) = fcm_env(&["--limit-alerts-per-token-per-hour", "1"]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let ask = json!({"t": "grant", "req": "g", "platform": "android", "token": "phone-1",
        "hostProfileId": "h1"});
    let (g, _) = grant(&mut agent, &mut fcm, "android", "phone-1").await;
    for _ in 1..3 {
        agent.send(ask.clone()).await;
        assert_eq!(agent.next().await["t"], "ok");
    }
    agent.send(ask.clone()).await;
    assert_eq!(agent.next().await["code"], "throttled");

    // Another computer key asking for the same phone spends only its own hour.
    let mut other = Agent::connect(&env, &SigningKey::generate()).await;
    other.send(ask).await;
    assert_eq!(other.next().await["t"], "ok");

    // The phone's alert hour is untouched by its grants.
    agent
        .send(json!({"t": "alert", "req": "1", "platform": "android",
            "message": {"token": "phone-1", "data": {}}, "grant": g}))
        .await;
    assert_eq!(agent.next().await["t"], "ok");
}

#[tokio::test]
async fn grants_name_their_issue_day_and_expire_after_30_days() {
    let (env, mut fcm) = fcm_env(&["--registry-secret", "shared"]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let (g, _) = grant(&mut agent, &mut fcm, "android", "phone-1").await;
    let today = unix_now() / 86_400;
    let parts: Vec<&str> = g.split('.').collect();
    assert_eq!(parts[..2], [agent.id.as_str(), today.to_string().as_str()]);

    // The grant key as PROTOCOL.md defines it: HMAC(secret, "pane alert grant v1").
    let derived = ring::hmac::sign(
        &ring::hmac::Key::new(ring::hmac::HMAC_SHA256, b"shared"),
        b"pane alert grant v1",
    );
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, derived.as_ref());
    let id = agent.id.clone();
    let issued = |day: i64| {
        let tag = ring::hmac::sign(&key, format!("{id}\nandroid\nphone-1\n{day}").as_bytes());
        format!("{id}.{day}.{}", BASE64URL_NOPAD.encode(tag.as_ref()))
    };
    assert_eq!(issued(today), g);
    let alert = |grant: String| {
        json!({"t": "alert", "req": "1", "platform": "android",
            "message": {"token": "phone-1", "data": {}}, "grant": grant})
    };
    for (day, answer) in [
        (today - 30, "ok"),
        (today - 31, "unbound"),
        (today + 2, "unbound"),
    ] {
        agent.send(alert(issued(day))).await;
        let got = agent.next().await;
        let got = got["code"].as_str().unwrap_or(got["t"].as_str().unwrap());
        assert_eq!(got, answer, "issued on day {day}, today {today}");
    }

    // The day is signed: moving it forward breaks the grant.
    agent
        .send(alert(format!("{}.{}.{}", parts[0], today + 1, parts[2])))
        .await;
    assert_eq!(agent.next().await["code"], "unbound");
}

#[tokio::test]
async fn alerts_carry_only_the_fields_pane_sends() {
    // Without push keys, a frame that passes the checks answers `unconfigured`.
    let env = Env::start(&[]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let ios = |payload: Value| {
        json!({"t": "alert", "req": "1", "platform": "ios", "token": "abcd",
            "pushType": "alert", "collapseId": "c1", "payload": payload})
    };
    let android = |message: Value| json!({"t": "alert", "req": "1", "platform": "android", "message": message});
    let long = "a".repeat(1025);
    let cases = [
        // A Notify question with its buttons.
        (
            ios(
                json!({"eventId": "e1", "hostProfileId": "h1", "notifyId": "n1", "paneId": "p1",
            "sessionPaneId": "p1", "panelId": "t1", "notifyUi": "options",
            "notifyChoices": ["Yes", "No"],
            "aps": {"alert": {"title": "Build", "body": "Build has a question"}, "sound": "default",
                "thread-id": "p1", "category": "options", "mutable-content": 1}}),
            ),
            "unconfigured",
        ),
        (
            ios(json!({"aps": {}, "url": "https://example.com"})),
            "bad-request",
        ),
        (
            ios(json!({"aps": {"alert": {"title": "x", "launch-image": "x"}}})),
            "bad-request",
        ),
        (
            ios(json!({"aps": {"alert": {"title": long}}})),
            "bad-request",
        ),
        (
            ios(json!({"aps": {}, "notifyChoices": ["a", "b", "c", "d"]})),
            "bad-request",
        ),
        // An agent alert, and a data-only Notify question.
        (
            android(
                json!({"token": "t", "notification": {"title": "Build", "body": "Build is blocked"},
            "android": {"notification": {"tag": "c1"}}, "data": {"eventId": "e1", "paneId": "p1"}}),
            ),
            "unconfigured",
        ),
        (
            android(json!({"token": "t", "android": {"priority": "high"},
            "data": {"notifyTitle": "Build", "notifyBody": "Build has a question",
                "notifyChoices": "[\"Yes\",\"No\"]", "notifyTag": "c1"}})),
            "unconfigured",
        ),
        (
            android(json!({"token": "t", "data": {"link": "https://example.com"}})),
            "bad-request",
        ),
        (
            android(json!({"token": "t", "data": {"eventId": 7}})),
            "bad-request",
        ),
        (
            android(json!({"token": "t", "notification": {"title": "x", "image": "https://x"}})),
            "bad-request",
        ),
        (android(json!({"token": "t", "webpush": {}})), "bad-request"),
        (
            android(json!({"token": "t", "android": {"priority": "high", "ttl": "0s"}})),
            "bad-request",
        ),
        (
            android(json!({"token": "t", "data": {"notifyBody": long}})),
            "bad-request",
        ),
    ];
    for (frame, want) in cases {
        agent.send(frame.clone()).await;
        assert_eq!(agent.next().await["code"], want, "{frame}");
    }
}

#[tokio::test]
async fn alerts_without_keys_or_with_bad_frames_are_refused() {
    let env = Env::start(&[]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    agent
        .send(
            json!({"t": "alert", "req": "1", "platform": "ios", "token": "abcd",
            "pushType": "alert", "payload": {}}),
        )
        .await;
    assert_eq!(agent.next().await["code"], "unconfigured");
    agent
        .send(json!({"t": "alert", "req": "2", "platform": "android",
            "message": {"token": "t", "data": {}}}))
        .await;
    assert_eq!(agent.next().await["code"], "unconfigured");
    // A message to a topic instead of one device is refused.
    agent
        .send(json!({"t": "alert", "req": "3", "platform": "android",
            "message": {"topic": "everyone", "data": {}}}))
        .await;
    let answer = agent.next().await;
    assert_eq!(
        (answer["req"].as_str(), answer["code"].as_str()),
        (Some("3"), Some("bad-request"))
    );
}

#[tokio::test]
async fn helpers_with_self_signed_certificates_take_each_others_acme_challenges() {
    use pane_relay::registry::{AcmeTxt, Registry, Update};
    // A first deploy: both helpers still serve self-signed certificates, which no
    // relay trusts (no --provider-ca), and each needs the other's challenge.
    let (us, eu) = (helper("us").await, helper("eu").await);
    let url = |env: &Env| format!("https://127.0.0.1:{}/v1/registry", env.addr().port());
    for (to, region) in [(&eu, "us"), (&us, "eu")] {
        let client = Registry::new(&[url(to)], Some("s3cret".into()), None, 10).unwrap();
        let name = format!("_acme-challenge.{region}.relay.{D}");
        let challenge = AcmeTxt {
            name: name.clone(),
            values: vec!["token-1".into()],
        };
        client.publish_acme(challenge.clone()).await.unwrap();
        let txt = dns_query(to.dns(), format!("{name}."), RecordType::TXT, false).await;
        assert_eq!(
            txt.answers.len(),
            1,
            "{region}'s challenge on the other helper"
        );

        // Only a relay with the secret may set one.
        let stranger = Registry::new(&[url(to)], Some("wrong".into()), None, 10).unwrap();
        assert!(stranger.publish_acme(challenge).await.is_err());

        // Computer updates, which carry local addresses, still need a trusted certificate.
        let update = Update {
            id: "bbbbbbbbbbbbbbbb".into(),
            region: region.into(),
            local: vec![Ipv4Addr::new(192, 168, 1, 2)],
            txt: Some(vec!["x".into()]),
            online: true,
        };
        let refused = client.publish(update).await.unwrap_err();
        assert!(refused.contains("tls"), "{refused}");
    }
}

/// Posts `update` to `env`'s registry as another relay does.
async fn post_update(env: &Env, update: Value) {
    let body = update.to_string();
    let (code, _) = env
        .http(
            "POST",
            "/v1/registry",
            "authorization: Bearer s3cret\r\n",
            &body,
        )
        .await;
    assert_eq!(code, 200);
}

#[tokio::test]
async fn a_late_offline_from_the_region_a_computer_left_keeps_its_new_region() {
    let us = helper("us").await;
    let agent = Agent::connect(&us, &SigningKey::generate()).await;
    let name = format!("{}.{D}.", agent.id);
    let us_ip = Ipv4Addr::new(203, 0, 113, 10);
    assert_eq!(resolves(us.dns(), name.clone()).await, vec![us_ip]);

    // The ap relay posts that the computer left it after the computer is already on us.
    post_update(
        &us,
        json!({"id": agent.id, "region": "ap", "local": [], "txt": null, "online": false}),
    )
    .await;

    assert_eq!(resolves(us.dns(), name).await, vec![us_ip]);
    assert_eq!(us.status(&agent.id).await["state"], "online");
}

#[tokio::test]
async fn the_resync_restores_the_region_of_a_computer_connected_here() {
    let (url, mut posts) = fake_helper(Some(Duration::ZERO)).await;
    let us = Env::start(&[
        "--region",
        "us",
        "--dns",
        "127.0.0.1:0",
        "--region-ip",
        "us=203.0.113.10,ap=192.0.2.44",
        "--registry-secret",
        "s3cret",
        "--registry-url",
        &url,
        "--registry-resync-secs",
        "1",
    ])
    .await;
    let agent = Agent::connect(&us, &SigningKey::generate()).await;

    // A stale update from another relay lands after the computer connected here.
    post_update(
        &us,
        json!({"id": agent.id, "region": "ap", "local": [], "txt": null, "online": true}),
    )
    .await;

    // Within a resync, this relay answers its own region again...
    let name = format!("{}.{D}.", agent.id);
    let us_ip = Ipv4Addr::new(203, 0, 113, 10);
    let deadline = Instant::now() + WAIT;
    while resolves(us.dns(), name.clone()).await != vec![us_ip] && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(resolves(us.dns(), name).await, vec![us_ip]);

    // ...and tells the other helpers the same.
    while posts.try_recv().is_ok() {}
    let body = tokio::time::timeout(WAIT, posts.recv())
        .await
        .expect("a resync")
        .unwrap();
    let ours = body
        .as_array()
        .into_iter()
        .flatten()
        .find(|u| u["id"] == agent.id.as_str())
        .cloned()
        .expect("the resync names the computer");
    assert_eq!(
        (&ours["region"], &ours["online"]),
        (&json!("us"), &json!(true))
    );
}

#[tokio::test]
async fn computers_get_one_time_google_trust_services_keys_minted_with_the_vm_account() {
    let mut publicca = Provider::start(|path, _| match path {
        "/v1/projects/pane-eab/locations/global/externalAccountKeys" => (
            200,
            r#"{"name":"projects/pane-eab/locations/global/externalAccountKeys/k1","keyId":"kid-production","b64MacKey":"c2VjcmV0LXByb2R1Y3Rpb24="}"#.to_string(),
        ),
        "/staging/v1/projects/pane-eab/locations/global/externalAccountKeys" => (
            200,
            r#"{"keyId":"kid-staging","b64MacKey":"c2VjcmV0LXN0YWdpbmc="}"#.to_string(),
        ),
        _ => (404, String::new()),
    })
    .await;
    let (metadata_url, _metadata) = metadata_server().await;
    let staging_url = format!("{}/staging", publicca.url);
    let env = Env::start(&[
        "--eab-project",
        "pane-eab",
        "--limit-eab-per-day",
        "2",
        "--metadata-url",
        &metadata_url,
        "--publicca-url",
        &publicca.url,
        "--publicca-staging-url",
        &staging_url,
        "--provider-ca",
        publicca.ca.to_str().unwrap(),
    ])
    .await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;

    agent.send(json!({"t": "eab", "req": "1"})).await;
    assert_eq!(
        agent.next().await,
        json!({"t": "ok", "req": "1", "keyId": "kid-production", "hmacKey": "c2VjcmV0LXByb2R1Y3Rpb24="})
    );
    let mint = publicca.next().await;
    assert_eq!(header(&mint, "authorization"), Some("Bearer ya29.keyless"));

    agent
        .send(json!({"t": "eab", "req": "2", "staging": true}))
        .await;
    assert_eq!(
        agent.next().await,
        json!({"t": "ok", "req": "2", "keyId": "kid-staging", "hmacKey": "c2VjcmV0LXN0YWdpbmc="})
    );
    assert_eq!(
        publicca.next().await.path,
        "/staging/v1/projects/pane-eab/locations/global/externalAccountKeys"
    );

    // Past its daily keys the computer is refused without a call to Google.
    agent.send(json!({"t": "eab", "req": "3"})).await;
    let answer = agent.next().await;
    assert_eq!(
        (answer["req"].as_str(), answer["code"].as_str()),
        (Some("3"), Some("throttled"))
    );
    assert!(publicca.received.try_recv().is_err());

    // Another computer has its own keys.
    let mut other = Agent::connect(&env, &SigningKey::generate()).await;
    other.send(json!({"t": "eab", "req": "1"})).await;
    assert_eq!(other.next().await["keyId"], "kid-production");
}

#[tokio::test]
async fn a_relay_without_an_eab_project_says_it_has_no_keys() {
    let env = Env::start(&[]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    agent.send(json!({"t": "eab", "req": "1"})).await;
    let answer = agent.next().await;
    assert_eq!(
        (answer["req"].as_str(), answer["code"].as_str()),
        (Some("1"), Some("unconfigured"))
    );
}

#[tokio::test]
async fn a_public_ca_refusal_reaches_the_computer_without_a_key() {
    let publicca = Provider::start(|_, _| {
        (
            403,
            r#"{"error":{"code":403,"message":"Permission 'publicca.externalAccountKeys.create' denied","status":"PERMISSION_DENIED"}}"#.to_string(),
        )
    })
    .await;
    let (metadata_url, _metadata) = metadata_server().await;
    let env = Env::start(&[
        "--eab-project",
        "pane-eab",
        "--metadata-url",
        &metadata_url,
        "--publicca-url",
        &publicca.url,
        "--provider-ca",
        publicca.ca.to_str().unwrap(),
    ])
    .await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    agent.send(json!({"t": "eab", "req": "1"})).await;
    let answer = agent.next().await;
    assert_eq!(answer["code"], "provider");
    assert!(
        answer["message"]
            .as_str()
            .unwrap()
            .contains("answered 403 Permission 'publicca.externalAccountKeys.create' denied"),
        "{answer}"
    );
    assert!(answer.get("hmacKey").is_none());
}
