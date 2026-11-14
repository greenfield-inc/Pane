//! A relay gets, then renews, its own certificate from Pebble (a test ACME CA)
//! with DNS-01. The relay runs no DNS itself: it posts its challenge values to a
//! helper relay, and Pebble validates them against that helper's DNS.
//!
//! Set PEBBLE_BIN and PEBBLE_DIR (Pebble's source folder, for its test
//! certificates) to run it; otherwise it is skipped.

use clap::Parser;
use data_encoding::HEXLOWER;
use pane_relay::Config;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName};
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpListener, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const D: &str = "relay.test";

struct Pebble(Child);

impl Drop for Pebble {
    fn drop(&mut self) {
        self.0.kill().ok();
        self.0.wait().ok();
    }
}

fn free_tcp_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// A port free for both UDP and TCP, for the helper's DNS.
fn free_dns_port() -> u16 {
    loop {
        let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = udp.local_addr().unwrap().port();
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn client_config(roots: &[CertificateDer<'static>]) -> Arc<rustls::ClientConfig> {
    let mut store = rustls::RootCertStore::empty();
    for root in roots {
        store.add(root.clone()).unwrap();
    }
    Arc::new(
        rustls::ClientConfig::builder_with_provider(provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(store)
            .with_no_client_auth(),
    )
}

/// Pebble's issuing root, from its management interface.
async fn pebble_root(mgmt: u16, minica: &CertificateDer<'static>) -> CertificateDer<'static> {
    let tcp = TcpStream::connect(("127.0.0.1", mgmt)).await.unwrap();
    let name = ServerName::try_from("localhost").unwrap();
    let mut s = tokio_rustls::TlsConnector::from(client_config(std::slice::from_ref(minica)))
        .connect(name, tcp)
        .await
        .unwrap();
    s.write_all(b"GET /roots/0 HTTP/1.1\r\nhost: localhost\r\nconnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut out = Vec::new();
    let _ = s.read_to_end(&mut out).await;
    let text = String::from_utf8_lossy(&out);
    let pem = &text[text.find("-----BEGIN").expect("a PEM root")..];
    CertificateDer::from_pem_slice(pem.as_bytes()).unwrap()
}

/// The certificate `addr` presents for `sni`, if it chains to `root`.
async fn served_cert(
    addr: SocketAddr,
    sni: &str,
    root: &CertificateDer<'static>,
) -> Option<CertificateDer<'static>> {
    let tcp = TcpStream::connect(addr).await.ok()?;
    let name = ServerName::try_from(sni.to_string()).ok()?;
    let s = tokio_rustls::TlsConnector::from(client_config(std::slice::from_ref(root)))
        .connect(name, tcp)
        .await
        .ok()?;
    s.get_ref().1.peer_certificates()?.first().cloned()
}

/// Waits until `addr` serves a certificate from `root` other than `previous`.
async fn wait_for_cert(
    addr: SocketAddr,
    sni: &str,
    root: &CertificateDer<'static>,
    previous: Option<&CertificateDer<'static>>,
) -> CertificateDer<'static> {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if let Some(cert) = served_cert(addr, sni, root).await
            && Some(&cert) != previous
        {
            return cert;
        }
        assert!(Instant::now() < deadline, "no new certificate for {sni}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn start_pebble(bin: &str, dir: &Path, scratch: &Path, dns: u16) -> (Pebble, u16, u16) {
    let (port, mgmt) = (free_tcp_port(), free_tcp_port());
    let config = scratch.join("pebble.json");
    let certs = dir.join("test/certs/localhost");
    let json = serde_json::json!({"pebble": {
        "listenAddress": format!("127.0.0.1:{port}"),
        "managementListenAddress": format!("127.0.0.1:{mgmt}"),
        "certificate": certs.join("cert.pem"),
        "privateKey": certs.join("key.pem"),
        "httpPort": free_tcp_port(),
        "tlsPort": free_tcp_port(),
        // Short-lived certificates, so the relay renews one during the test.
        "profiles": {"default": {"description": "test", "validityPeriod": 15}},
    }});
    std::fs::write(&config, json.to_string()).unwrap();
    let mut child = Command::new(bin)
        .arg("-config")
        .arg(&config)
        .arg("-dnsserver")
        .arg(format!("127.0.0.1:{dns}"))
        .env("PEBBLE_VA_NOSLEEP", "1")
        .env("PEBBLE_WFE_NONCEREJECT", "0")
        .stdout(Stdio::piped())
        .spawn()
        .expect("start pebble");
    let stdout = child.stdout.take().unwrap();
    let pebble = Pebble(child);
    let mut lines = BufReader::new(stdout).lines();
    loop {
        let line = lines.next().expect("pebble exited").unwrap();
        if line.contains("Listening on") {
            break;
        }
    }
    std::thread::spawn(move || for _ in lines {});
    (pebble, port, mgmt)
}

#[tokio::test]
async fn a_relay_gets_and_renews_its_certificate_through_the_helper_dns() {
    let (Ok(bin), Ok(dir)) = (std::env::var("PEBBLE_BIN"), std::env::var("PEBBLE_DIR")) else {
        // CI's Relay Tests job must run it: a missing Pebble there is a broken setup.
        assert!(
            std::env::var("PANE_RELAY_INTEGRATION_REQUIRED").as_deref() != Ok("1"),
            "PANE_RELAY_INTEGRATION_REQUIRED=1 but PEBBLE_BIN or PEBBLE_DIR is not set: install Pebble for this test"
        );
        eprintln!("skipped: set PEBBLE_BIN and PEBBLE_DIR to run the Pebble test");
        return;
    };
    let dir = PathBuf::from(dir);
    let mut rnd = [0u8; 8];
    getrandom::fill(&mut rnd).unwrap();
    let scratch =
        std::env::temp_dir().join(format!("pane-relay-acme-{}.noindex", HEXLOWER.encode(&rnd)));
    std::fs::create_dir_all(&scratch).unwrap();
    let dns = free_dns_port();
    let (_pebble, acme_port, mgmt) = start_pebble(&bin, &dir, &scratch, dns);
    let minica = CertificateDer::from_pem_file(dir.join("test/certs/pebble.minica.pem")).unwrap();
    let root = pebble_root(mgmt, &minica).await;

    // The helper: DNS for <D>, with a fixed certificate the other relay trusts.
    let ck = rcgen::generate_simple_self_signed(vec![D.to_string(), "127.0.0.1".into()]).unwrap();
    std::fs::write(scratch.join("helper.pem"), ck.cert.pem()).unwrap();
    std::fs::write(scratch.join("helper.key"), ck.signing_key.serialize_pem()).unwrap();
    let path = |name: &str| scratch.join(name).display().to_string();
    let helper = pane_relay::start(Config::parse_from([
        "pane-relay",
        "--domain",
        D,
        "--listen",
        "127.0.0.1:0",
        "--cert",
        &path("helper.pem"),
        "--key",
        &path("helper.key"),
        "--dns",
        &format!("127.0.0.1:{dns}"),
        "--public-ip",
        "127.0.0.1",
        "--region-ip",
        "us=127.0.0.1,eu=127.0.0.1",
        "--registry-secret",
        "s3cret",
    ]))
    .await
    .unwrap();

    // Pebble's CA first (the only root trusted for ACME), then the helper's certificate.
    let mut trust = std::fs::read_to_string(dir.join("test/certs/pebble.minica.pem")).unwrap();
    trust.push_str(&ck.cert.pem());
    std::fs::write(scratch.join("trust.pem"), trust).unwrap();
    let registry = format!("https://127.0.0.1:{}/v1/registry", helper.https_addr.port());
    let relay = pane_relay::start(Config::parse_from([
        "pane-relay",
        "--domain",
        D,
        "--region",
        "eu",
        "--listen",
        "127.0.0.1:0",
        "--acme-cache",
        &path("eu-acme"),
        "--acme-directory",
        &format!("https://localhost:{acme_port}/dir"),
        "--acme-email",
        "ops@relay.test",
        "--registry-url",
        &registry,
        "--registry-secret",
        "s3cret",
        "--provider-ca",
        &path("trust.pem"),
    ]))
    .await
    .unwrap();

    let sni = format!("eu.relay.{D}");
    let first = wait_for_cert(relay.https_addr, &sni, &root, None).await;
    // The same certificate covers <D>.
    assert_eq!(
        served_cert(relay.https_addr, D, &root).await,
        Some(first.clone())
    );
    #[cfg(unix)]
    for file in ["account.json", "key.pem", "cert.pem"] {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(scratch.join("eu-acme").join(file))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{file}");
    }

    // With a third of its 15 s left, the relay renews and serves the new one without restarting.
    let second = wait_for_cert(relay.https_addr, &sni, &root, Some(&first)).await;
    assert_ne!(first, second);

    relay.shutdown().await;
    helper.shutdown().await;
    std::fs::remove_dir_all(&scratch).ok();
}
