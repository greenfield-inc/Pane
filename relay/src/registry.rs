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
use tokio::sync::{Notify, oneshot};

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
    /// When `txt` was last set.
    pub txt_at: SystemTime,
}

/// A relay's own ACME challenge values for one of its names, such as
/// `{"name":"_acme-challenge.us.relay.<D>","values":["..."]}`. Empty values clear it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcmeTxt {
    pub name: String,
    pub values: Vec<String>,
}

type Reply = oneshot::Sender<Result<(), String>>;

/// Updates a computer may send in one POST; more go in several.
const MAX_BATCH: usize = 5000;

/// What is waiting to go to one helper. Updates for the same id merge, so the
/// queue holds at most one update per computer however slow the helper is.
#[derive(Default)]
struct Queue {
    updates: HashMap<String, Update>,
    update_replies: Vec<Reply>,
    acme: HashMap<String, (AcmeTxt, Vec<Reply>)>,
}

/// One helper's queue, sent by its own task, so a helper that is down delays only itself.
#[derive(Default)]
struct Helper {
    queue: Mutex<Queue>,
    wake: Notify,
}

impl Helper {
    fn push_updates(&self, updates: Vec<Update>, reply: Option<Reply>) {
        let mut q = self.queue.lock().unwrap();
        for u in updates {
            match q.updates.get_mut(&u.id) {
                Some(queued) => {
                    queued.region = u.region;
                    queued.local = u.local;
                    queued.online = u.online;
                    if u.txt.is_some() {
                        queued.txt = u.txt;
                    }
                }
                None => {
                    q.updates.insert(u.id.clone(), u);
                }
            }
        }
        q.update_replies.extend(reply);
        drop(q);
        self.wake.notify_one();
    }

    fn push_acme(&self, t: AcmeTxt, reply: Option<Reply>) {
        let mut q = self.queue.lock().unwrap();
        let slot = q
            .acme
            .entry(t.name.clone())
            .or_insert_with(|| (t.clone(), Vec::new()));
        slot.0 = t;
        slot.1.extend(reply);
        drop(q);
        self.wake.notify_one();
    }

    /// Sends whatever is queued: all updates as JSON arrays of up to `MAX_BATCH`, then each ACME value.
    async fn run(
        self: Arc<Self>,
        url: String,
        secret: Option<String>,
        tls: Arc<rustls::ClientConfig>,
    ) {
        let send = |suffix: &'static str, body: Vec<u8>| {
            let (url, secret, tls) = (&url, secret.as_deref(), tls.clone());
            async move {
                tokio::time::timeout(POST_TIMEOUT, post(url, suffix, secret, &body, tls))
                    .await
                    .map_err(|_| {
                        format!(
                            "registry {url} did not answer in {} s",
                            POST_TIMEOUT.as_secs()
                        )
                    })
                    .and_then(|r| r.map_err(|e| format!("registry {url}: {e}")))
            }
        };
        loop {
            self.wake.notified().await;
            let q = std::mem::take(&mut *self.queue.lock().unwrap());
            if !q.updates.is_empty() {
                let updates: Vec<Update> = q.updates.into_values().collect();
                let mut result = Ok(());
                for batch in updates.chunks(MAX_BATCH) {
                    let body = serde_json::to_vec(batch).unwrap_or_default();
                    let sent = send("", body).await;
                    if let Err(e) = &sent {
                        tracing::warn!(count = batch.len(), error = %e, "registry update failed");
                    }
                    result = result.and(sent);
                }
                for reply in q.update_replies {
                    let _ = reply.send(result.clone());
                }
            }
            for (name, (t, replies)) in q.acme {
                let sent = send("/acme", serde_json::to_vec(&t).unwrap_or_default()).await;
                if let Err(e) = &sent {
                    tracing::warn!(name, error = %e, "registry ACME update failed");
                }
                for reply in replies {
                    let _ = reply.send(sent.clone());
                }
            }
        }
    }
}

const POST_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Registry {
    entries: Mutex<HashMap<String, Entry>>,
    /// ACME TXT values by name; `true` marks this relay's own, which it re-posts.
    acme: Mutex<HashMap<String, (Vec<String>, bool)>>,
    helpers: Vec<Arc<Helper>>,
    max_entries: usize,
}

impl Registry {
    /// A registry that also forwards every update to each helper in `urls`.
    /// `extra_ca` adds PEM roots trusted for the helpers' certificates.
    pub fn new(
        urls: &[String],
        secret: Option<String>,
        extra_ca: Option<&Path>,
        max_entries: usize,
    ) -> Result<Self, crate::Error> {
        let tls = client_config(extra_ca)?;
        let helpers = urls
            .iter()
            .map(|url| {
                let helper = Arc::new(Helper::default());
                tokio::spawn(helper.clone().run(url.clone(), secret.clone(), tls.clone()));
                helper
            })
            .collect();
        Ok(Self {
            entries: Mutex::default(),
            acme: Mutex::default(),
            helpers,
            max_entries,
        })
    }

    /// Applies an update; false when it is for a new computer and the registry is full.
    pub fn apply(&self, u: &Update) -> bool {
        let mut entries = self.entries.lock().unwrap();
        if !entries.contains_key(&u.id) && entries.len() >= self.max_entries {
            return false;
        }
        let now = SystemTime::now();
        let entry = entries.entry(u.id.clone()).or_insert_with(|| Entry {
            region: u.region.clone(),
            local: Vec::new(),
            txt: Vec::new(),
            online: false,
            last_seen: now,
            txt_at: now,
        });
        entry.region = u.region.clone();
        entry.local = u.local.clone();
        if let Some(txt) = &u.txt
            && *txt != entry.txt
        {
            entry.txt = txt.clone();
            entry.txt_at = now;
        }
        entry.online = u.online;
        entry.last_seen = now;
        true
    }

    /// True when the registry has no room for a computer it does not know.
    pub fn is_full(&self) -> bool {
        self.entries.lock().unwrap().len() >= self.max_entries
    }

    /// Clears TXT values of offline computers set more than `txt_ttl` ago (an
    /// ACME check takes seconds), and forgets computers offline more than `ttl`.
    pub fn prune(&self, ttl: Duration, txt_ttl: Duration) {
        let now = SystemTime::now();
        let age = |t: SystemTime| now.duration_since(t).unwrap_or_default();
        self.entries.lock().unwrap().retain(|_, e| {
            if e.online {
                return true;
            }
            if age(e.txt_at) >= txt_ttl {
                e.txt.clear();
            }
            age(e.last_seen) < ttl
        });
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

    /// Sets this relay's ACME TXT values here and on every helper (see `wait`).
    pub async fn publish_acme(&self, t: AcmeTxt) -> Result<(), String> {
        self.set_acme(&t, true);
        let mut replies = Vec::new();
        for helper in &self.helpers {
            let (tx, rx) = oneshot::channel();
            helper.push_acme(t.clone(), Some(tx));
            replies.push(rx);
        }
        wait(replies).await
    }

    /// Applies the update here and queues it for every helper. With TXT values,
    /// waits as `wait` does; other updates return at once.
    pub async fn publish(&self, update: Update) -> Result<(), String> {
        let _ = self.apply(&update);
        if update.txt.is_none() {
            for helper in &self.helpers {
                helper.push_updates(vec![update.clone()], None);
            }
            return Ok(());
        }
        let mut replies = Vec::new();
        for helper in &self.helpers {
            let (tx, rx) = oneshot::channel();
            helper.push_updates(vec![update.clone()], Some(tx));
            replies.push(rx);
        }
        wait(replies).await
    }

    /// Queues the current entry of each of `ids`, and this relay's own ACME
    /// values, for every helper without waiting: a restarted helper relearns them.
    pub fn resync(&self, ids: &[String]) {
        if self.helpers.is_empty() {
            return;
        }
        let updates: Vec<Update> = {
            let entries = self.entries.lock().unwrap();
            ids.iter()
                .filter_map(|id| {
                    let e = entries.get(id)?;
                    Some(Update {
                        id: id.clone(),
                        region: e.region.clone(),
                        local: e.local.clone(),
                        txt: Some(e.txt.clone()),
                        online: e.online,
                    })
                })
                .collect()
        };
        let own: Vec<AcmeTxt> = {
            let acme = self.acme.lock().unwrap();
            acme.iter()
                .filter(|(_, (_, own))| *own)
                .map(|(name, (values, _))| AcmeTxt {
                    name: name.clone(),
                    values: values.clone(),
                })
                .collect()
        };
        for helper in &self.helpers {
            helper.push_updates(updates.clone(), None);
            for t in &own {
                helper.push_acme(t.clone(), None);
            }
        }
    }
}

/// Succeeds once one helper took the update: a helper that is down answers no
/// DNS, so resolvers ask the other. With no helpers, succeeds at once.
async fn wait(replies: Vec<oneshot::Receiver<Result<(), String>>>) -> Result<(), String> {
    if replies.is_empty() {
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
