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

/// Polls `server` until `name` has A records, then returns them.
async fn resolves(server: SocketAddr, name: String) -> Vec<Ipv4Addr> {
    let deadline = Instant::now() + WAIT;
    loop {
        let ips = a_records(&dns_query(server, name.clone(), RecordType::A, false).await);
        if !ips.is_empty() || Instant::now() > deadline {
            return ips;
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

    let payload = json!({"aps": {"content-available": 1}, "paneEvent": "x"});
    agent
        .send(
            json!({"t": "alert", "req": "7", "platform": "ios", "token": "abcdef0123",
            "pushType": "background", "collapseId": "session-1", "payload": payload}),
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
            "pushType": "alert", "payload": {"aps": {"alert": "hi"}}}),
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

    agent
        .send(
            json!({"t": "alert", "req": "1", "platform": "ios", "token": "beef",
            "pushType": "alert", "payload": {"aps": {}}}),
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
            "pushType": "alert", "payload": {"aps": {}}}),
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

    let message = json!({"token": "fcm-device-token", "data": {"paneEvent": "x"},
        "android": {"priority": "high"}});
    for req in ["1", "2"] {
        agent
            .send(json!({"t": "alert", "req": req, "platform": "android", "message": message}))
            .await;
        assert_eq!(
            agent.next().await,
            json!({"t": "ok", "req": req, "status": 200,
                "body": r#"{"name":"projects/pane-test/messages/1"}"#})
        );
    }

    // One token request (cached for the second alert), then the two sends.
    let t = fcm.next().await;
    assert_eq!(t.path, "/token");
    let form = String::from_utf8(t.body).unwrap();
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
        "--fcm-metadata-url",
        &metadata_url,
        "--fcm-url",
        &fcm.url,
        "--provider-ca",
        fcm.ca.to_str().unwrap(),
    ])
    .await;
    let mut agent = Agent::connect(&env, &SigningKey::generate()).await;
    for req in ["1", "2"] {
        agent
            .send(json!({"t": "alert", "req": req, "platform": "android",
                "message": {"token": "fcm-device-token", "data": {}}}))
            .await;
        assert_eq!(agent.next().await["status"], 200);
    }

    // One metadata request (the token is cached for the second alert).
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
    let alert = |req: &str| {
        json!({"t": "alert", "req": req, "platform": "android",
        "message": {"token": "fcm-device-token", "data": {}}})
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

    // A token request and two sends; the throttled alert never reached FCM.
    for _ in 0..3 {
        fcm.next().await;
    }
    assert!(fcm.received.try_recv().is_err());
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
