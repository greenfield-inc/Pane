//! Push alerts that computers send through the relay with the Pane app's keys
//! (PROTOCOL.md, Alerts): APNs over HTTP/2 with an ES256 token, FCM v1 with an
//! OAuth2 token from a service account key or, keyless, from the GCE metadata server.

use crate::Error;
use crate::config::Config;
use bytes::Bytes;
use data_encoding::BASE64URL_NOPAD;
use p256::ecdsa::signature::Signer;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const TIMEOUT: Duration = Duration::from_secs(10);
const HOUR: Duration = Duration::from_secs(3600);
const APNS_JWT_TTL: Duration = Duration::from_secs(50 * 60);
const FCM_TOKEN_MARGIN: Duration = Duration::from_secs(5 * 60);
const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_DEFAULT_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const MAX_ANSWER_BODY: usize = 2048;
const MAX_READ_BODY: usize = 64 * 1024;

pub struct Alerts {
    apns: Option<Apns>,
    fcm: Option<Fcm>,
    http: Http,
    limit: usize,
    token_limit: usize,
    /// Sliding hours by `id <id>` and `token <device token>`.
    windows: Mutex<HashMap<String, Window>>,
}

#[derive(Default)]
struct Window {
    sent: VecDeque<Instant>,
    logged: Option<Instant>,
}

struct Apns {
    key: p256::ecdsa::SigningKey,
    key_id: String,
    team_id: String,
    topic: String,
    url: String,
    sandbox_url: String,
    jwt: Mutex<Option<(String, Instant)>>,
}

struct Fcm {
    auth: FcmAuth,
    project: String,
    url: String,
    token: tokio::sync::Mutex<Option<(String, Instant)>>,
}

/// Where FCM access tokens come from.
enum FcmAuth {
    /// A service account key file: sign a JWT and trade it at `token_url`.
    Key {
        key: Box<ring::signature::RsaKeyPair>,
        email: String,
        token_url: String,
    },
    /// The VM's attached service account, through the GCE metadata server.
    Metadata { url: String },
}

enum Request<'a> {
    Ios {
        token: &'a str,
        push_type: &'a str,
        collapse_id: Option<&'a str>,
        payload: &'a Value,
    },
    Android {
        message: &'a Value,
    },
}

fn bad(message: &str) -> Value {
    json!({"t": "error", "code": "bad-request", "message": message})
}

/// The longest string an alert field may hold.
const MAX_FIELD: usize = 1024;

fn short_str(v: &Value) -> bool {
    v.as_str().is_some_and(|s| s.len() <= MAX_FIELD)
}

/// An object whose every field passes `check`.
fn only(v: &Value, check: impl Fn(&str, &Value) -> bool) -> bool {
    v.as_object()
        .is_some_and(|o| o.iter().all(|(k, v)| check(k, v)))
}

fn title_body(v: &Value) -> bool {
    only(v, |k, v| matches!(k, "title" | "body") && short_str(v))
}

/// The fields Pane puts in an iOS payload (main/src/daemon/mobilePushSender.ts).
fn ios_payload_ok(payload: &Value) -> bool {
    only(payload, |k, v| match k {
        "eventId" | "hostProfileId" | "notifyId" | "paneId" | "sessionPaneId" | "panelId"
        | "notifyUi" => short_str(v),
        "notifyClear" => v.is_boolean(),
        "notifyChoices" => v
            .as_array()
            .is_some_and(|a| a.len() <= 3 && a.iter().all(short_str)),
        "aps" => only(v, |k, v| match k {
            "alert" => title_body(v),
            "sound" | "thread-id" | "category" => short_str(v),
            "mutable-content" | "content-available" => *v == 1,
            _ => false,
        }),
        _ => false,
    })
}

/// The fields Pane puts in an FCM message (main/src/daemon/mobilePushSender.ts).
fn android_message_ok(message: &Value) -> bool {
    only(message, |k, v| match k {
        "token" => short_str(v),
        "notification" => title_body(v),
        "android" => only(v, |k, v| match k {
            "priority" => *v == "high",
            "notification" => only(v, |k, v| k == "tag" && short_str(v)),
            _ => false,
        }),
        "data" => only(v, |k, v| {
            matches!(
                k,
                "eventId"
                    | "hostProfileId"
                    | "notifyId"
                    | "paneId"
                    | "sessionPaneId"
                    | "panelId"
                    | "notifyTag"
                    | "notifyUi"
                    | "notifyTitle"
                    | "notifyBody"
                    | "notifyChoices"
                    | "notifyClear"
            ) && short_str(v)
        }),
        _ => false,
    })
}

fn parse(v: &Value) -> Result<Request<'_>, Value> {
    match v["platform"].as_str() {
        Some("ios") => {
            let token = v["token"].as_str().unwrap_or("");
            if token.is_empty()
                || token.len() > 200
                || !token.bytes().all(|b| b.is_ascii_hexdigit())
            {
                return Err(bad("token must be an APNs device token in hex"));
            }
            let push_type = v["pushType"].as_str().unwrap_or("alert");
            if push_type != "alert" && push_type != "background" {
                return Err(bad("pushType must be alert or background"));
            }
            let collapse_id = match &v["collapseId"] {
                Value::Null => None,
                Value::String(s) if s.len() <= 64 => Some(s.as_str()),
                _ => return Err(bad("collapseId must be a string of at most 64 bytes")),
            };
            if !ios_payload_ok(&v["payload"]) {
                return Err(bad(
                    "payload must hold only the fields Pane sends, each string at most 1024 bytes",
                ));
            }
            Ok(Request::Ios {
                token,
                push_type,
                collapse_id,
                payload: &v["payload"],
            })
        }
        Some("android") => {
            let message = &v["message"];
            let to_device = message["token"].as_str().is_some_and(|t| !t.is_empty());
            if !to_device {
                return Err(bad("message must be an FCM v1 message with a device token"));
            }
            if !android_message_ok(message) {
                return Err(bad(
                    "message must hold only the fields Pane sends, each string at most 1024 bytes",
                ));
            }
            Ok(Request::Android { message })
        }
        _ => Err(bad("platform must be ios or android")),
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `<base64url header>.<base64url claims>.<base64url signature>`.
fn jwt(
    header: Value,
    claims: Value,
    sign: impl FnOnce(&[u8]) -> Result<Vec<u8>, String>,
) -> Result<String, String> {
    let input = format!(
        "{}.{}",
        BASE64URL_NOPAD.encode(header.to_string().as_bytes()),
        BASE64URL_NOPAD.encode(claims.to_string().as_bytes())
    );
    let sig = sign(input.as_bytes())?;
    Ok(format!("{input}.{}", BASE64URL_NOPAD.encode(&sig)))
}

fn read_pkcs8(path: &std::path::Path, what: &str) -> Result<Vec<u8>, Error> {
    let pem = std::fs::read(path).map_err(|e| format!("reading {what} {}: {e}", path.display()))?;
    pkcs8_from_pem(&pem).map_err(|e| format!("{what} {}: {e}", path.display()).into())
}

fn pkcs8_from_pem(pem: &[u8]) -> Result<Vec<u8>, String> {
    match PrivateKeyDer::from_pem_slice(pem) {
        Ok(PrivateKeyDer::Pkcs8(k)) => Ok(k.secret_pkcs8_der().to_vec()),
        Ok(_) => Err("expected a PKCS#8 private key (BEGIN PRIVATE KEY)".into()),
        Err(e) => Err(e.to_string()),
    }
}

impl Alerts {
    pub fn load(cfg: &Config) -> Result<Alerts, Error> {
        let apns = match (&cfg.apns_key_path, &cfg.apns_key_id, &cfg.apns_team_id) {
            (None, None, None) => None,
            (Some(path), Some(key_id), Some(team_id)) => {
                use p256::pkcs8::DecodePrivateKey;
                let der = read_pkcs8(path, "--apns-key-path")?;
                let key = p256::ecdsa::SigningKey::from_pkcs8_der(&der)
                    .map_err(|e| format!("--apns-key-path {}: {e}", path.display()))?;
                Some(Apns {
                    key,
                    key_id: key_id.clone(),
                    team_id: team_id.clone(),
                    topic: cfg.apns_topic.clone(),
                    url: cfg.apns_url.trim_end_matches('/').to_string(),
                    sandbox_url: cfg.apns_sandbox_url.trim_end_matches('/').to_string(),
                    jwt: Mutex::new(None),
                })
            }
            _ => {
                return Err("--apns-key-path, --apns-key-id and --apns-team-id go together".into());
            }
        };
        let fcm = match &cfg.fcm_service_account {
            None => cfg.fcm_project.as_ref().map(|project| Fcm {
                auth: FcmAuth::Metadata {
                    url: cfg.fcm_metadata_url.clone(),
                },
                project: project.clone(),
                url: cfg.fcm_url.trim_end_matches('/').to_string(),
                token: tokio::sync::Mutex::new(None),
            }),
            Some(path) => {
                let what = "--fcm-service-account";
                let text = std::fs::read_to_string(path)
                    .map_err(|e| format!("reading {what} {}: {e}", path.display()))?;
                let sa: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("{what} {}: {e}", path.display()))?;
                let field = |name: &str| {
                    sa[name]
                        .as_str()
                        .map(String::from)
                        .ok_or_else(|| format!("{what} {} has no {name}", path.display()))
                };
                let der = pkcs8_from_pem(field("private_key")?.as_bytes())
                    .map_err(|e| format!("{what} {} private_key: {e}", path.display()))?;
                let key = ring::signature::RsaKeyPair::from_pkcs8(&der)
                    .map_err(|e| format!("{what} {} private_key: {e}", path.display()))?;
                let token_url = cfg
                    .fcm_token_url
                    .clone()
                    .or_else(|| field("token_uri").ok())
                    .unwrap_or_else(|| FCM_DEFAULT_TOKEN_URL.to_string());
                let project = match &cfg.fcm_project {
                    Some(p) => p.clone(),
                    None => field("project_id")?,
                };
                Some(Fcm {
                    auth: FcmAuth::Key {
                        key: Box::new(key),
                        email: field("client_email")?,
                        token_url,
                    },
                    project,
                    url: cfg.fcm_url.trim_end_matches('/').to_string(),
                    token: tokio::sync::Mutex::new(None),
                })
            }
        };
        Ok(Alerts {
            apns,
            fcm,
            http: Http::new(cfg.provider_ca.as_deref())?,
            limit: cfg.limit_alerts_per_hour,
            token_limit: cfg.limit_alerts_per_token_per_hour,
            windows: Mutex::default(),
        })
    }

    /// Delivers one `alert` frame from computer `id`; returns the answer frame without `req`.
    pub async fn deliver(&self, id: &str, frame: &Value) -> Value {
        let request = match parse(frame) {
            Ok(r) => r,
            Err(answer) => return answer,
        };
        let (platform, configured, token) = match &request {
            Request::Ios { token, .. } => ("ios", self.apns.is_some(), *token),
            Request::Android { message } => (
                "android",
                self.fcm.is_some(),
                message["token"].as_str().unwrap_or(""),
            ),
        };
        if !configured {
            return json!({"t": "error", "code": "unconfigured",
                "message": format!("This relay has no {platform} push keys.")});
        }
        if let Err(message) = self.admit(id, &format!("{platform} {token}")) {
            return json!({"t": "error", "code": "throttled", "message": message});
        }
        let sent = tokio::time::timeout(TIMEOUT, async {
            match request {
                Request::Ios {
                    token,
                    push_type,
                    collapse_id,
                    payload,
                } => {
                    let apns = self.apns.as_ref().expect("checked above");
                    self.apns(apns, token, push_type, collapse_id, payload)
                        .await
                }
                Request::Android { message } => {
                    let fcm = self.fcm.as_ref().expect("checked above");
                    self.fcm(fcm, message).await
                }
            }
        })
        .await
        .unwrap_or_else(|_| Err("the push provider did not answer in 10 s".into()));
        match sent {
            Ok((status, body)) => {
                tracing::info!(id, platform, status, "alert sent");
                let text = String::from_utf8_lossy(&body);
                let mut end = text.len().min(MAX_ANSWER_BODY);
                while !text.is_char_boundary(end) {
                    end -= 1;
                }
                json!({"t": "ok", "status": status, "body": &text[..end]})
            }
            Err(e) => {
                tracing::warn!(id, platform, error = %e, "alert failed");
                json!({"t": "error", "code": "provider", "message": e})
            }
        }
    }

    /// Counts an alert against the computer's and the device's sliding hours;
    /// an error names the limit it is over, and nothing is counted then.
    fn admit(&self, id: &str, device: &str) -> Result<(), String> {
        let now = Instant::now();
        let mut windows = self.windows.lock().unwrap();
        let checks = [
            (format!("id {id}"), self.limit, "computer"),
            (format!("token {device}"), self.token_limit, "device"),
        ];
        for (key, limit, what) in &checks {
            let w = windows.entry(key.clone()).or_default();
            while w.sent.front().is_some_and(|t| now - *t >= HOUR) {
                w.sent.pop_front();
            }
            if w.sent.len() >= *limit {
                if w.logged.is_none_or(|t| now - t >= HOUR) {
                    w.logged = Some(now);
                    tracing::warn!(id, limit, per = what, "alerts throttled");
                }
                return Err(format!("At most {limit} alerts an hour per {what}."));
            }
        }
        for (key, _, _) in &checks {
            windows.entry(key.clone()).or_default().sent.push_back(now);
        }
        Ok(())
    }

    /// Forgets computers and devices with no alerts in the last hour.
    pub fn prune(&self) {
        let now = Instant::now();
        self.windows.lock().unwrap().retain(|_, w| {
            w.sent.back().is_some_and(|t| now - *t < HOUR)
                || w.logged.is_some_and(|t| now - t < HOUR)
        });
    }

    async fn apns(
        &self,
        apns: &Apns,
        token: &str,
        push_type: &str,
        collapse_id: Option<&str>,
        payload: &Value,
    ) -> Result<(u16, Bytes), String> {
        let mut headers = vec![
            ("authorization", format!("bearer {}", apns.jwt()?)),
            ("apns-topic", apns.topic.clone()),
            ("apns-push-type", push_type.to_string()),
        ];
        if push_type == "background" {
            headers.push(("apns-priority", "5".into()));
        }
        if let Some(c) = collapse_id {
            headers.push(("apns-collapse-id", c.to_string()));
        }
        let body = Bytes::from(payload.to_string());
        let path = format!("/3/device/{token}");
        let first = self
            .http
            .post(&format!("{}{path}", apns.url), &headers, body.clone())
            .await?;
        let reason = |b: &Bytes| {
            serde_json::from_slice::<Value>(b).ok()?["reason"]
                .as_str()
                .map(String::from)
        };
        if first.0 == 400 && reason(&first.1).as_deref() == Some("BadDeviceToken") {
            return self
                .http
                .post(&format!("{}{path}", apns.sandbox_url), &headers, body)
                .await;
        }
        Ok(first)
    }

    async fn fcm(&self, fcm: &Fcm, message: &Value) -> Result<(u16, Bytes), String> {
        let token = fcm.access_token(&self.http).await?;
        let url = format!("{}/v1/projects/{}/messages:send", fcm.url, fcm.project);
        let headers = [("authorization", format!("Bearer {token}"))];
        let body = Bytes::from(json!({"message": message}).to_string());
        self.http.post(&url, &headers, body).await
    }
}

impl Apns {
    /// The provider token, signed again every 50 minutes.
    fn jwt(&self) -> Result<String, String> {
        let mut cached = self.jwt.lock().unwrap();
        if let Some((token, at)) = &*cached
            && at.elapsed() < APNS_JWT_TTL
        {
            return Ok(token.clone());
        }
        let token = jwt(
            json!({"alg": "ES256", "kid": self.key_id}),
            json!({"iss": self.team_id, "iat": now_secs()}),
            |input| {
                let sig: p256::ecdsa::Signature = self.key.sign(input);
                Ok(sig.to_bytes().to_vec())
            },
        )?;
        *cached = Some((token.clone(), Instant::now()));
        Ok(token)
    }
}

impl Fcm {
    /// An OAuth2 access token, fetched again 5 minutes before it expires.
    async fn access_token(&self, http: &Http) -> Result<String, String> {
        let mut cached = self.token.lock().await;
        if let Some((token, until)) = &*cached
            && Instant::now() < *until
        {
            return Ok(token.clone());
        }
        let (status, body) = match &self.auth {
            FcmAuth::Key {
                key,
                email,
                token_url,
            } => key_token(http, key, email, token_url).await?,
            FcmAuth::Metadata { url } => metadata_get(url).await?,
        };
        if status != 200 {
            return Err(format!("the FCM token endpoint answered {status}"));
        }
        let v: Value = serde_json::from_slice(&body)
            .map_err(|_| "the FCM token endpoint answered invalid JSON".to_string())?;
        let token = v["access_token"]
            .as_str()
            .ok_or("the FCM token endpoint answered no access_token")?
            .to_string();
        let lifetime = Duration::from_secs(v["expires_in"].as_u64().unwrap_or(3600));
        *cached = Some((
            token.clone(),
            Instant::now() + lifetime.saturating_sub(FCM_TOKEN_MARGIN),
        ));
        Ok(token)
    }
}

/// Trades a JWT signed with the service account key for an access token.
async fn key_token(
    http: &Http,
    key: &ring::signature::RsaKeyPair,
    email: &str,
    token_url: &str,
) -> Result<(u16, Bytes), String> {
    let iat = now_secs();
    let assertion = jwt(
        json!({"alg": "RS256", "typ": "JWT"}),
        json!({"iss": email, "scope": FCM_SCOPE, "aud": token_url,
            "iat": iat, "exp": iat + 3600}),
        |input| {
            let mut sig = vec![0; key.public().modulus_len()];
            key.sign(
                &ring::signature::RSA_PKCS1_SHA256,
                &ring::rand::SystemRandom::new(),
                input,
                &mut sig,
            )
            .map_err(|_| "signing the FCM token request failed".to_string())?;
            Ok(sig)
        },
    )?;
    let form = format!(
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={assertion}"
    );
    let headers = [(
        "content-type",
        "application/x-www-form-urlencoded".to_string(),
    )];
    http.post(token_url, &headers, form.into()).await
}

/// GETs a token from the GCE metadata server (plain HTTP/1.0 on the VM's link).
async fn metadata_get(url: &str) -> Result<(u16, Bytes), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or("--fcm-metadata-url must start with http://")?;
    let (authority, path) = rest.split_at(rest.find('/').unwrap_or(rest.len()));
    let fetch = async {
        let mut tcp = TcpStream::connect(authority).await?;
        let req =
            format!("GET {path} HTTP/1.0\r\nhost: {authority}\r\nmetadata-flavor: Google\r\n\r\n");
        tcp.write_all(req.as_bytes()).await?;
        let mut out = Vec::new();
        tcp.take(MAX_READ_BODY as u64).read_to_end(&mut out).await?;
        Ok::<_, std::io::Error>(out)
    };
    let out = tokio::time::timeout(TIMEOUT, fetch)
        .await
        .map_err(|_| "the metadata server timed out".to_string())?
        .map_err(|e| format!("the metadata server at {authority}: {e}"))?;
    let split = out
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("the metadata server answered no HTTP head")?;
    let status = std::str::from_utf8(&out[..split])
        .ok()
        .and_then(|head| head.split(' ').nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or("the metadata server answered no status")?;
    Ok((status, Bytes::copy_from_slice(&out[split + 4..])))
}

/// A minimal HTTP/2 client that keeps one connection per provider host.
struct Http {
    tls: tokio_rustls::TlsConnector,
    conns: Mutex<HashMap<String, h2::client::SendRequest<Bytes>>>,
}

impl Http {
    fn new(extra_ca: Option<&std::path::Path>) -> Result<Http, Error> {
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
        let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
        cfg.alpn_protocols = vec![b"h2".to_vec()];
        Ok(Http {
            tls: tokio_rustls::TlsConnector::from(Arc::new(cfg)),
            conns: Mutex::default(),
        })
    }

    async fn conn(&self, authority: &str) -> Result<h2::client::SendRequest<Bytes>, String> {
        let cached = self.conns.lock().unwrap().get(authority).cloned();
        if let Some(send) = cached
            && let Ok(send) = send.ready().await
        {
            return Ok(send);
        }
        let (host, port) = match authority.rsplit_once(':') {
            Some((h, p)) => (h, p.parse().map_err(|_| "bad provider port")?),
            None => (authority, 443),
        };
        let tcp = TcpStream::connect((host, port))
            .await
            .map_err(|e| format!("connecting to {host}: {e}"))?;
        let name = ServerName::try_from(host.to_string()).map_err(|_| "bad provider host")?;
        let tls = self
            .tls
            .connect(name, tcp)
            .await
            .map_err(|e| format!("TLS with {host}: {e}"))?;
        if tls.get_ref().1.alpn_protocol() != Some(b"h2") {
            return Err(format!("{host} does not speak HTTP/2"));
        }
        let (send, conn) = h2::client::handshake(tls)
            .await
            .map_err(|e| format!("HTTP/2 with {host}: {e}"))?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let send = send
            .ready()
            .await
            .map_err(|e| format!("HTTP/2 with {host}: {e}"))?;
        self.conns
            .lock()
            .unwrap()
            .insert(authority.to_string(), send.clone());
        Ok(send)
    }

    /// POSTs `body` (JSON unless a content-type header says otherwise); returns the status and body.
    async fn post(
        &self,
        url: &str,
        headers: &[(&str, String)],
        body: Bytes,
    ) -> Result<(u16, Bytes), String> {
        let rest = url
            .strip_prefix("https://")
            .ok_or("provider URLs must start with https://")?;
        let authority = rest.split('/').next().unwrap_or(rest);
        let mut send = self.conn(authority).await?;
        let mut req = http::Request::post(url);
        if !headers.iter().any(|(k, _)| *k == "content-type") {
            req = req.header("content-type", "application/json");
        }
        for (k, v) in headers {
            req = req.header(*k, v);
        }
        let req = req.body(()).map_err(|e| e.to_string())?;
        let (response, mut stream) = send
            .send_request(req, false)
            .map_err(|e| format!("sending to {authority}: {e}"))?;
        stream
            .send_data(body, true)
            .map_err(|e| format!("sending to {authority}: {e}"))?;
        let response = response
            .await
            .map_err(|e| format!("reading from {authority}: {e}"))?;
        let status = response.status().as_u16();
        let mut body = response.into_body();
        let mut out = Vec::new();
        while let Some(chunk) = body.data().await {
            let chunk = chunk.map_err(|e| format!("reading from {authority}: {e}"))?;
            let _ = body.flow_control().release_capacity(chunk.len());
            if out.len() < MAX_READ_BODY {
                out.extend_from_slice(&chunk);
            }
        }
        Ok((status, out.into()))
    }
}
