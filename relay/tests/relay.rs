//! Drives a relay on loopback through its public interfaces: TLS, the agent protocol, HTTP and DNS.

use clap::Parser;
use data_encoding::{BASE64URL_NOPAD, HEXLOWER};
use hickory_proto::op::{Message, Query, ResponseCode};
use hickory_proto::rr::{Name, RData, RecordType};
use p256::ecdsa::{DerSignature, SigningKey, signature::Signer};
use p256::elliptic_curve::Generate;
use p256::pkcs8::{DecodePrivateKey, EncodePublicKey};
use pane_relay::{Config, Relay};
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

impl Env {
    async fn start(extra: &[&str]) -> Env {
        let dir = scratch_dir();
        let ck = rcgen::generate_simple_self_signed(vec![D.to_string(), format!("*.relay.{D}")])
            .unwrap();
        std::fs::write(dir.join("cert.pem"), ck.cert.pem()).unwrap();
        std::fs::write(dir.join("key.pem"), ck.signing_key.serialize_pem()).unwrap();
        let mut args = vec![
            "pane-relay".to_string(),
            "--domain".into(),
            D.into(),
            "--listen".into(),
            "127.0.0.1:0".into(),
            "--cert".into(),
            dir.join("cert.pem").display().to_string(),
            "--key".into(),
            dir.join("key.pem").display().to_string(),
        ];
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

    fn addr(&self) -> SocketAddr {
        self.relay.as_ref().unwrap().https_addr
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
        assert_eq!(challenge["t"], "challenge");
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
                    let tls = acceptor.accept(data).await.unwrap();
                    let sni = tls.get_ref().1.server_name().unwrap_or("").to_string();
                    let (r, mut w) = tokio::io::split(tls);
                    let mut line = String::new();
                    BufReader::new(r).read_line(&mut line).await.unwrap();
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

    async fn next(&mut self) -> Value {
        tokio::time::timeout(WAIT, self.frames.recv())
            .await
            .expect("frame in time")
            .expect("connection open")
    }

    /// A client connects to `sni` through the relay, sends a line and returns the computer's answer.
    async fn exchange(&self, env: &Env, sni: &str) -> std::io::Result<String> {
        let mut s = tls_connect(env.addr(), sni, &self.cert).await?;
        s.write_all(b"ping\n").await?;
        let mut out = String::new();
        s.read_to_string(&mut out).await?;
        Ok(out)
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
    assert_eq!(
        a(format!("aaaaaaaaaaaaaaaa.{D}."))
            .await
            .metadata
            .response_code,
        ResponseCode::NXDomain
    );
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
}

#[tokio::test]
async fn new_connections_past_the_limit_are_slowed_then_cut() {
    let env = Env::start(&["--limit-conns-per-min", "2"]).await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    let host = format!("{}.{D}", agent.id);

    for _ in 0..2 {
        let started = Instant::now();
        agent.exchange(&env, &host).await.unwrap();
        assert!(started.elapsed() < Duration::from_millis(900));
    }
    for _ in 0..2 {
        let started = Instant::now();
        agent.exchange(&env, &host).await.unwrap();
        assert!(
            started.elapsed() >= Duration::from_millis(900),
            "connection over the limit was not slowed"
        );
    }
    assert!(
        agent.exchange(&env, &host).await.is_err(),
        "connection past twice the limit was let through"
    );
    let close = agent.next().await;
    assert_eq!(
        (close["t"].as_str(), close["code"].as_str()),
        (Some("close"), Some("over-limit"))
    );
}
