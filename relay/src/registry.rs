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

/// TXT values per name: what ACME DNS-01 needs (a wildcard and its base name
/// share one name), each at most 64 bytes (ACME values are 43).
pub const MAX_TXT_VALUES: usize = 2;
pub const MAX_TXT_LEN: usize = 64;

pub fn valid_txt(values: &[String]) -> bool {
    values.len() <= MAX_TXT_VALUES && values.iter().all(|v| v.len() <= MAX_TXT_LEN)
}

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
    /// The computer has set TXT values (for its certificate) since this registry learned it.
    pub proven: bool,
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
/// Updates someone waits for (a computer's TXT values) are urgent and go first.
#[derive(Default)]
struct Queue {
    urgent: HashMap<String, Update>,
    urgent_replies: Vec<Reply>,
    updates: HashMap<String, Update>,
    acme: HashMap<String, (AcmeTxt, Vec<Reply>)>,
}

/// One request's worth of the queue.
enum Job {
    Updates(Vec<Update>, Vec<Reply>),
    Acme(AcmeTxt, Vec<Reply>),
}

impl Queue {
    /// Urgent updates first, then each ACME value, then up to `MAX_BATCH` other updates.
    fn next(&mut self) -> Option<Job> {
        if !self.urgent.is_empty() {
            let updates = std::mem::take(&mut self.urgent).into_values().collect();
            return Some(Job::Updates(
                updates,
                std::mem::take(&mut self.urgent_replies),
            ));
        }
        if let Some(name) = self.acme.keys().next().cloned() {
            let (t, replies) = self.acme.remove(&name)?;
            return Some(Job::Acme(t, replies));
        }
        if self.updates.is_empty() {
            return None;
        }
        let ids: Vec<String> = self.updates.keys().take(MAX_BATCH).cloned().collect();
        let batch = ids
            .iter()
            .filter_map(|id| self.updates.remove(id))
            .collect();
        Some(Job::Updates(batch, Vec::new()))
    }
}

/// `u` applied over `queued`: `txt: None` keeps the queued TXT values.
fn merge(queued: &mut Update, u: Update) {
    queued.region = u.region;
    queued.local = u.local;
    queued.online = u.online;
    if u.txt.is_some() {
        queued.txt = u.txt;
    }
}

/// One helper's queue, sent by its own task, so a helper that is down delays only itself.
#[derive(Default)]
struct Helper {
    queue: Mutex<Queue>,
    wake: Notify,
}

impl Helper {
    /// Queues updates; with `reply` they are urgent and the reply gets the helper's answer.
    fn push_updates(&self, updates: Vec<Update>, reply: Option<Reply>) {
        let mut q = self.queue.lock().unwrap();
        let q = &mut *q;
        for u in updates {
            let id = u.id.clone();
            if let Some(queued) = q.urgent.get_mut(&id) {
                merge(queued, u);
            } else if reply.is_some() {
                // An urgent update takes over any queued one for the same id.
                let mut queued = q.updates.remove(&id).unwrap_or_else(|| u.clone());
                merge(&mut queued, u);
                q.urgent.insert(id, queued);
            } else if let Some(queued) = q.updates.get_mut(&id) {
                merge(queued, u);
            } else {
                q.updates.insert(id, u);
            }
        }
        q.urgent_replies.extend(reply);
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

    /// Sends the queue one request at a time, in the order `Queue::next` gives.
    async fn run(self: Arc<Self>, url: String, secret: Option<String>, tls: Tls) {
        let send = |suffix: &'static str, body: Vec<u8>| {
            let (url, secret, tls) = (&url, secret.as_deref(), tls.clone());
            async move {
                tokio::time::timeout(POST_TIMEOUT, post(url, suffix, secret, &body, &tls))
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
            loop {
                let job = self.queue.lock().unwrap().next();
                let (sent, replies) = match job {
                    None => break,
                    Some(Job::Updates(batch, replies)) => {
                        let body = serde_json::to_vec(&batch).unwrap_or_default();
                        let sent = send("", body).await;
                        if let Err(e) = &sent {
                            tracing::warn!(count = batch.len(), error = %e, "registry update failed");
                        }
                        (sent, replies)
                    }
                    Some(Job::Acme(t, replies)) => {
                        let sent = send("/acme", serde_json::to_vec(&t).unwrap_or_default()).await;
                        if let Err(e) = &sent {
                            tracing::warn!(name = t.name, error = %e, "registry ACME update failed");
                        }
                        (sent, replies)
                    }
                };
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
        let tls = Tls {
            trusted: client_config(extra_ca)?,
            any: any_certificate_config()?,
        };
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

    /// Applies an update. A new computer in a full registry takes the place of
    /// the one offline longest; false when every computer is online.
    pub fn apply(&self, u: &Update) -> bool {
        let mut entries = self.entries.lock().unwrap();
        if !entries.contains_key(&u.id) && entries.len() >= self.max_entries {
            let oldest = entries
                .iter()
                .filter(|(_, e)| !e.online)
                .min_by_key(|(_, e)| e.last_seen)
                .map(|(id, _)| id.clone());
            match oldest {
                Some(id) => {
                    entries.remove(&id);
                }
                None => return false,
            }
        }
        let now = SystemTime::now();
        let entry = entries.entry(u.id.clone()).or_insert_with(|| Entry {
            region: u.region.clone(),
            local: Vec::new(),
            txt: Vec::new(),
            online: false,
            last_seen: now,
            txt_at: now,
            proven: false,
        });
        entry.region = u.region.clone();
        entry.local = u.local.clone();
        if let Some(txt) = &u.txt
            && *txt != entry.txt
        {
            entry.txt = txt.clone();
            entry.txt_at = now;
            entry.proven |= !txt.is_empty();
        }
        entry.online = u.online;
        entry.last_seen = now;
        true
    }

    /// True when the registry has no room for a computer it does not know.
    /// False when the registry is full and every computer in it is online.
    pub fn has_room(&self) -> bool {
        let entries = self.entries.lock().unwrap();
        entries.len() < self.max_entries || entries.values().any(|e| !e.online)
    }

    /// Clears TXT values of offline computers set more than `txt_ttl` ago (an
    /// ACME check takes seconds), and forgets computers offline more than `ttl`,
    /// or more than `unproven_ttl` when they never set TXT values.
    pub fn prune(&self, ttl: Duration, unproven_ttl: Duration, txt_ttl: Duration) {
        let now = SystemTime::now();
        let age = |t: SystemTime| now.duration_since(t).unwrap_or_default();
        self.entries.lock().unwrap().retain(|_, e| {
            if e.online {
                return true;
            }
            if age(e.txt_at) >= txt_ttl {
                e.txt.clear();
            }
            age(e.last_seen) < if e.proven { ttl } else { unproven_ttl }
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

/// Succeeds as soon as one helper took the update, and fails only when all
/// failed: a helper that is down answers no DNS, so resolvers ask the other.
/// With no helpers, succeeds at once.
async fn wait(replies: Vec<oneshot::Receiver<Result<(), String>>>) -> Result<(), String> {
    if replies.is_empty() {
        return Ok(());
    }
    let mut pending: tokio::task::JoinSet<_> = replies.into_iter().collect();
    let mut first_err = None;
    while let Some(answer) = pending.join_next().await {
        match answer {
            Ok(Ok(Ok(()))) => return Ok(()),
            Ok(Ok(Err(e))) => {
                first_err.get_or_insert(e);
            }
            _ => {
                first_err.get_or_insert("registry push stopped".to_string());
            }
        }
    }
    Err(first_err.unwrap_or_else(|| "registry push stopped".to_string()))
}

/// The client configurations for posting to helpers.
#[derive(Clone)]
struct Tls {
    /// WebPKI roots plus `--provider-ca`: for computer updates, which carry local addresses.
    trusted: Arc<rustls::ClientConfig>,
    /// Any certificate: for ACME challenges, signed with the secret instead (`acme_mac`).
    any: Arc<rustls::ClientConfig>,
}

/// How long a signed ACME challenge post stays valid.
pub const ACME_MAC_WINDOW_SECS: u64 = 300;

/// The `Pane-HMAC <unix secs> <base64url MAC>` value for an ACME challenge post: HMAC-SHA256
/// with the registry secret over `pane registry acme v1\n<secs>\n<path>\n<body>`.
pub fn acme_mac(secret: &str, secs: u64, path: &str, body: &[u8]) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret.as_bytes());
    let mut ctx = ring::hmac::Context::with_key(&key);
    ctx.update(format!("pane registry acme v1\n{secs}\n{path}\n").as_bytes());
    ctx.update(body);
    let tag = ctx.sign();
    format!(
        "Pane-HMAC {secs} {}",
        data_encoding::BASE64URL_NOPAD.encode(tag.as_ref())
    )
}

/// Checks an `acme_mac` value against the secret, the request and the clock.
pub fn acme_mac_ok(secret: &str, given: &str, path: &str, body: &[u8]) -> bool {
    let Some(secs) = given
        .strip_prefix("Pane-HMAC ")
        .and_then(|v| v.split(' ').next())
        .and_then(|t| t.parse::<u64>().ok())
    else {
        return false;
    };
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    if now.abs_diff(secs) > ACME_MAC_WINDOW_SECS {
        return false;
    }
    let want = acme_mac(secret, secs, path, body);
    want.len() == given.len()
        && want
            .bytes()
            .zip(given.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// POSTs JSON to an http(s) URL and succeeds on a 2xx answer.
///
/// ACME challenge posts (`suffix` "/acme") accept any certificate. On a first deploy every
/// relay still serves a self-signed certificate, and each needs a helper to publish its
/// challenge before it can get a real one, so verifying the helper's certificate would
/// deadlock. The secret never goes on the wire for them: the request carries a MAC over its
/// path, body and time (`acme_mac`), so an impostor helper learns nothing it can reuse
/// beyond 5 minutes, and challenge values are public in DNS anyway. Everything else
/// verifies the helper's certificate and sends the bearer secret.
async fn post(
    url: &str,
    suffix: &str,
    secret: Option<&str>,
    body: &[u8],
    configs: &Tls,
) -> Result<(), String> {
    let acme = suffix == "/acme";
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
    let auth = match secret {
        Some(s) if acme => {
            let secs = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            format!("authorization: {}\r\n", acme_mac(s, secs, &path, body))
        }
        Some(s) => format!("authorization: Bearer {s}\r\n"),
        None => String::new(),
    };
    let tls_config = if acme { &configs.any } else { &configs.trusted }.clone();
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

/// Accepts any server certificate, still checking that the server holds its key.
#[derive(Debug)]
struct AnyCertificate(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(
        &self,
        _: &rustls::pki_types::CertificateDer<'_>,
        _: &[rustls::pki_types::CertificateDer<'_>],
        _: &rustls::pki_types::ServerName<'_>,
        _: &[u8],
        _: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn any_certificate_config() -> Result<Arc<rustls::ClientConfig>, crate::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Ok(Arc::new(
        rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AnyCertificate(provider)))
            .with_no_client_auth(),
    ))
}
