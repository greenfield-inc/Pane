//! The registry: each computer's region, local addresses, TXT values and last-seen time,
//! plus the relays' own ACME TXT values.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::path::Path;
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

/// A relay's own ACME challenge values for one of its names, such as
/// `{"name":"_acme-challenge.us.relay.<D>","values":["..."]}`. Empty values clear it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcmeTxt {
    pub name: String,
    pub values: Vec<String>,
}

/// One POST for a helper: the path after the registry URL, its JSON body, and a log label.
struct Post {
    suffix: &'static str,
    body: Vec<u8>,
    label: String,
    reply: Option<oneshot::Sender<Result<(), String>>>,
}

pub struct Registry {
    entries: Mutex<HashMap<String, Entry>>,
    /// ACME TXT values by name; `true` marks this relay's own, which it re-posts.
    acme: Mutex<HashMap<String, (Vec<String>, bool)>>,
    /// One ordered queue per helper URL, so a helper that is down delays only itself.
    push: Vec<mpsc::UnboundedSender<Post>>,
}

impl Registry {
    /// A registry that also forwards every update to each helper in `urls`, in order.
    /// `extra_ca` adds PEM roots trusted for the helpers' certificates.
    pub fn new(
        urls: &[String],
        secret: Option<String>,
        extra_ca: Option<&Path>,
    ) -> Result<Self, crate::Error> {
        let tls = client_config(extra_ca)?;
        let push = urls
            .iter()
            .map(|url| {
                let (tx, mut rx) = mpsc::unbounded_channel::<Post>();
                let (url, secret, tls) = (url.clone(), secret.clone(), tls.clone());
                tokio::spawn(async move {
                    while let Some(p) = rx.recv().await {
                        let result = tokio::time::timeout(
                            Duration::from_secs(10),
                            post(&url, p.suffix, secret.as_deref(), &p.body, tls.clone()),
                        )
                        .await
                        .map_err(|_| format!("registry {url} did not answer in 10 s"))
                        .and_then(|r| r.map_err(|e| format!("registry {url}: {e}")));
                        if let Err(e) = &result {
                            tracing::warn!(update = %p.label, error = %e, "registry update failed");
                        }
                        if let Some(reply) = p.reply {
                            let _ = reply.send(result);
                        }
                    }
                });
                tx
            })
            .collect();
        Ok(Self {
            entries: Mutex::default(),
            acme: Mutex::default(),
            push,
        })
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

    /// Stores ACME TXT values that another relay posted.
    pub fn apply_acme(&self, t: &AcmeTxt) {
        self.set_acme(t, false);
    }

    fn set_acme(&self, t: &AcmeTxt, own: bool) {
        let mut acme = self.acme.lock().unwrap();
        if t.values.is_empty() {
            acme.remove(&t.name);
        } else {
            acme.insert(t.name.clone(), (t.values.clone(), own));
        }
    }

    /// The ACME TXT values for `name` (a lowercase name without the trailing dot).
    pub fn acme_txt(&self, name: &str) -> Vec<String> {
        let acme = self.acme.lock().unwrap();
        acme.get(name).map(|(v, _)| v.clone()).unwrap_or_default()
    }

    /// This relay's ACME TXT values that are still set, for the periodic re-post.
    pub fn own_acme(&self) -> Vec<AcmeTxt> {
        let acme = self.acme.lock().unwrap();
        acme.iter()
            .filter(|(_, (_, own))| *own)
            .map(|(name, (values, _))| AcmeTxt {
                name: name.clone(),
                values: values.clone(),
            })
            .collect()
    }

    /// Sets this relay's ACME TXT values here and on every helper (see `publish`).
    pub async fn publish_acme(&self, t: AcmeTxt) -> Result<(), String> {
        self.set_acme(&t, true);
        let body = serde_json::to_vec(&t).unwrap_or_default();
        self.send("/acme", body, t.name.clone(), true).await
    }

    /// Applies the update here and sends it to every helper (see `send`).
    pub async fn publish(&self, update: Update) -> Result<(), String> {
        self.apply(&update);
        let body = serde_json::to_vec(&update).unwrap_or_default();
        let wait = update.txt.is_some();
        self.send("", body, update.id, wait).await
    }

    /// Queues one POST for every helper. With `wait` (TXT values), waits for the
    /// helpers and succeeds when at least one took it: a helper that is down
    /// answers no DNS, so resolvers ask the other.
    async fn send(
        &self,
        suffix: &'static str,
        body: Vec<u8>,
        label: String,
        wait: bool,
    ) -> Result<(), String> {
        let mut replies = Vec::new();
        for push in &self.push {
            let (tx, rx) = oneshot::channel();
            let post = Post {
                suffix,
                body: body.clone(),
                label: label.clone(),
                reply: wait.then_some(tx),
            };
            if push.send(post).is_ok() && wait {
                replies.push(rx);
            }
        }
        if !wait || self.push.is_empty() {
            return Ok(());
        }
        let mut first_err = None;
        for rx in replies {
            match rx.await {
                Ok(Ok(())) => return Ok(()),
                Ok(Err(e)) => {
                    first_err.get_or_insert(e);
                }
                Err(_) => {
                    first_err.get_or_insert("registry push stopped".to_string());
                }
            }
        }
        Err(first_err.unwrap_or_else(|| "registry push stopped".to_string()))
    }
}

/// POSTs JSON to an http(s) URL and succeeds on a 2xx answer.
async fn post(
    url: &str,
    suffix: &str,
    secret: Option<&str>,
    body: &[u8],
    tls_config: Arc<rustls::ClientConfig>,
) -> Result<(), String> {
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
    let path = format!("{}{suffix}", path.trim_end_matches('/'));
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
        let mut s = tokio_rustls::TlsConnector::from(tls_config)
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

fn client_config(extra_ca: Option<&Path>) -> Result<Arc<rustls::ClientConfig>, crate::Error> {
    use rustls::pki_types::{CertificateDer, pem::PemObject};
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    if let Some(path) = extra_ca {
        for cert in CertificateDer::pem_file_iter(path)
            .map_err(|e| format!("reading --provider-ca {}: {e}", path.display()))?
        {
            roots.add(cert?)?;
        }
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Ok(Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth(),
    ))
}
