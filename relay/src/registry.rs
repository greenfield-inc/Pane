//! The registry: each computer's region, local addresses, TXT values and last-seen time.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Update {
    pub id: String,
    pub region: String,
    #[serde(default)]
    pub local: Vec<Ipv4Addr>,
    #[serde(default)]
    pub txt: Option<Vec<String>>,
    pub online: bool,
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub region: String,
    pub local: Vec<Ipv4Addr>,
    pub txt: Vec<String>,
    pub online: bool,
    pub last_seen: SystemTime,
}

type Push = (Update, Option<oneshot::Sender<Result<(), String>>>);

pub struct Registry {
    entries: Mutex<HashMap<String, Entry>>,
    push: Option<mpsc::UnboundedSender<Push>>,
}

impl Registry {
    /// A registry that also forwards every update to the helper at `url`, in order.
    pub fn new(url: Option<String>, secret: Option<String>) -> Self {
        let push = url.map(|url| {
            let (tx, mut rx) = mpsc::unbounded_channel::<Push>();
            tokio::spawn(async move {
                while let Some((update, reply)) = rx.recv().await {
                    let body = serde_json::to_vec(&update).unwrap_or_default();
                    let result = tokio::time::timeout(
                        Duration::from_secs(10),
                        post(&url, secret.as_deref(), &body),
                    )
                    .await
                    .map_err(|_| "registry did not answer in 10 s".to_string())
                    .and_then(|r| r);
                    if let Err(e) = &result {
                        tracing::warn!(id = %update.id, error = %e, "registry update failed");
                    }
                    if let Some(reply) = reply {
                        let _ = reply.send(result);
                    }
                }
            });
            tx
        });
        Self {
            entries: Mutex::default(),
            push,
        }
    }

    pub fn apply(&self, u: &Update) {
        let mut entries = self.entries.lock().unwrap();
        let entry = entries.entry(u.id.clone()).or_insert_with(|| Entry {
            region: u.region.clone(),
            local: Vec::new(),
            txt: Vec::new(),
            online: false,
            last_seen: SystemTime::now(),
        });
        entry.region = u.region.clone();
        entry.local = u.local.clone();
        if let Some(txt) = &u.txt {
            entry.txt = txt.clone();
        }
        entry.online = u.online;
        entry.last_seen = SystemTime::now();
    }

    pub fn get(&self, id: &str) -> Option<Entry> {
        self.entries.lock().unwrap().get(id).cloned()
    }

    /// Applies the update here and, with a helper URL, there. TXT updates wait for the helper.
    pub async fn publish(&self, update: Update) -> Result<(), String> {
        self.apply(&update);
        let Some(push) = &self.push else {
            return Ok(());
        };
        if update.txt.is_some() {
            let (tx, rx) = oneshot::channel();
            push.send((update, Some(tx)))
                .map_err(|_| "registry push stopped".to_string())?;
            rx.await.map_err(|_| "registry push stopped".to_string())?
        } else {
            let _ = push.send((update, None));
            Ok(())
        }
    }
}

/// POSTs JSON to an http(s) URL and succeeds on a 2xx answer.
async fn post(url: &str, secret: Option<&str>, body: &[u8]) -> Result<(), String> {
    let (tls, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return Err("registry URL must start with http:// or https://".into());
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/v1/registry"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().map_err(|_| "bad registry port")?),
        None => (authority, if tls { 443 } else { 80 }),
    };
    let auth = secret
        .map(|s| format!("authorization: Bearer {s}\r\n"))
        .unwrap_or_default();
    let head = format!(
        "POST {path} HTTP/1.1\r\nhost: {authority}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{auth}connection: close\r\n\r\n",
        body.len()
    );
    let tcp = TcpStream::connect((host, port))
        .await
        .map_err(|e| format!("connect: {e}"))?;
    let mut answer = Vec::new();
    if tls {
        let name = rustls::pki_types::ServerName::try_from(host.to_string())
            .map_err(|_| "bad registry host")?;
        let mut s = tokio_rustls::TlsConnector::from(client_config())
            .connect(name, tcp)
            .await
            .map_err(|e| format!("tls: {e}"))?;
        s.write_all(head.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        s.write_all(body).await.map_err(|e| e.to_string())?;
        let _ = s.read_to_end(&mut answer).await;
    } else {
        let mut s = tcp;
        s.write_all(head.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        s.write_all(body).await.map_err(|e| e.to_string())?;
        let _ = s.read_to_end(&mut answer).await;
    }
    let status = String::from_utf8_lossy(&answer)
        .split(' ')
        .nth(1)
        .unwrap_or("")
        .to_string();
    if status.starts_with('2') {
        Ok(())
    } else {
        Err(format!("registry answered {status:?}"))
    }
}

fn client_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: std::sync::OnceLock<Arc<rustls::ClientConfig>> = std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            for cert in rustls_native_certs::load_native_certs().certs {
                let _ = roots.add(cert);
            }
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            Arc::new(
                rustls::ClientConfig::builder_with_provider(provider)
                    .with_safe_default_protocol_versions()
                    .expect("ring supports the default TLS versions")
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
            )
        })
        .clone()
}
