//! The relay's own https API on <D> and <region>.relay.<D>.

use crate::id::is_valid_id;
use crate::io::{BoxStream, Prefixed, Request, SWITCHING, read_request, respond, respond_json};
use crate::registry::Update;
use crate::state::{Presence, State};
use serde_json::json;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const PAIR_HTML: &str = include_str!("pair.html");
const IOS_APP_ID: &str = "FBM5YSF467.com.dcouple.pane.mobile";
const ANDROID_PACKAGE: &str = "com.dcouple.pane.mobile";
const MAX_BODY: usize = 64 * 1024;

pub async fn serve(state: Arc<State>, mut s: BoxStream, peer: IpAddr) {
    let Ok(Ok((req, rest))) =
        tokio::time::timeout(Duration::from_secs(10), read_request(&mut s)).await
    else {
        return;
    };
    let path = req.path.as_str();
    let _ = match (req.method.as_str(), path) {
        ("GET", "/v1/agent") => {
            if !is_upgrade(&req) {
                respond(
                    &mut s,
                    400,
                    "text/plain",
                    "",
                    b"expected Upgrade: pane-relay/1\n",
                )
                .await
            } else if s.write_all(SWITCHING).await.is_ok() {
                let stream: BoxStream = Box::new(Prefixed::new(rest, s));
                crate::agent::run(state, stream, peer).await;
                return;
            } else {
                return;
            }
        }
        ("GET", p) if p.starts_with("/v1/data/") => {
            let conn = &p["/v1/data/".len()..];
            match state.take_pending(conn).filter(|_| is_upgrade(&req)) {
                Some(tx) => {
                    if s.write_all(SWITCHING).await.is_ok() {
                        let _ = tx.send(Box::new(Prefixed::new(rest, s)));
                    }
                    return;
                }
                None => {
                    respond(
                        &mut s,
                        404,
                        "text/plain",
                        "",
                        b"unknown or expired connection\n",
                    )
                    .await
                }
            }
        }
        ("GET", "/healthz") => {
            let body =
                json!({"ok": true, "region": state.cfg.region, "computers": state.computers()});
            respond_json(&mut s, 200, &body).await
        }
        ("GET", "/v1/relays") => respond_json(&mut s, 200, &relays(&state)).await,
        ("GET", p) if p.starts_with("/v1/status/") => {
            let id = &p["/v1/status/".len()..];
            if is_valid_id(id) {
                respond_json(&mut s, 200, &status(&state, id)).await
            } else {
                respond_json(&mut s, 404, &json!({"error": "not a computer id"})).await
            }
        }
        ("GET", "/pair") | ("GET", "/pair/") => {
            let headers = "cache-control: no-store\r\nreferrer-policy: no-referrer\r\n";
            respond(
                &mut s,
                200,
                "text/html; charset=utf-8",
                headers,
                PAIR_HTML.as_bytes(),
            )
            .await
        }
        ("GET", "/.well-known/apple-app-site-association") => {
            let body = json!({"applinks": {"apps": [], "details": [{
                "appID": IOS_APP_ID,
                "appIDs": [IOS_APP_ID],
                "paths": ["/pair*"],
                "components": [{"/": "/pair*"}],
            }]}});
            respond_json(&mut s, 200, &body).await
        }
        ("GET", "/.well-known/assetlinks.json") => {
            let fingerprints = &state.cfg.android_cert_sha256;
            let body = if fingerprints.is_empty() {
                json!([])
            } else {
                json!([{
                    "relation": ["delegate_permission/common.handle_all_urls"],
                    "target": {
                        "namespace": "android_app",
                        "package_name": ANDROID_PACKAGE,
                        "sha256_cert_fingerprints": fingerprints,
                    },
                }])
            };
            respond_json(&mut s, 200, &body).await
        }
        ("POST", "/v1/registry") => registry_post(&state, &req, rest, &mut s).await,
        _ => respond(&mut s, 404, "text/plain", "", b"not found\n").await,
    };
}

fn is_upgrade(req: &Request) -> bool {
    req.header("upgrade")
        .is_some_and(|u| u.eq_ignore_ascii_case("pane-relay/1"))
}

fn relays(state: &State) -> serde_json::Value {
    let mut list: Vec<_> = state
        .cfg
        .relays
        .0
        .iter()
        .map(|(region, host)| json!({"region": region, "host": host}))
        .collect();
    if list.is_empty() {
        let host = format!("{}.relay.{}", state.cfg.region, state.domain);
        list.push(json!({"region": state.cfg.region, "host": host}));
    }
    json!({ "relays": list })
}

fn iso(t: SystemTime) -> String {
    time::OffsetDateTime::from(t)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn status(state: &State, id: &str) -> serde_json::Value {
    let local = state.status(id);
    let remote = state.registry.get(id);
    let (presence, since) = match (local, remote) {
        (Some(st), _) if st.presence == Presence::Online => ("online", Some(st.since)),
        // Connected to another region, as the helper's registry reports.
        (_, Some(e)) if e.online && e.region != state.cfg.region => ("online", Some(e.last_seen)),
        (Some(st), _) if st.presence == Presence::Asleep => ("asleep", Some(st.since)),
        (Some(st), _) => ("offline", Some(st.since)),
        (None, Some(e)) => ("offline", Some(e.last_seen)),
        (None, None) => ("offline", None),
    };
    json!({"state": presence, "since": since.map(iso)})
}

async fn registry_post(
    state: &State,
    req: &Request,
    mut body: Vec<u8>,
    s: &mut BoxStream,
) -> std::io::Result<()> {
    let authorized = match (&state.cfg.registry_secret, req.header("authorization")) {
        (Some(secret), Some(auth)) => auth
            .strip_prefix("Bearer ")
            .is_some_and(|given| constant_time_eq(given.as_bytes(), secret.as_bytes())),
        _ => false,
    };
    if !authorized {
        return respond_json(s, 401, &json!({"error": "bad or missing registry secret"})).await;
    }
    let len: usize = req
        .header("content-length")
        .and_then(|l| l.parse().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return respond_json(s, 413, &json!({"error": "body too large"})).await;
    }
    while body.len() < len {
        let mut chunk = vec![0u8; len - body.len()];
        let n = tokio::time::timeout(Duration::from_secs(10), s.read(&mut chunk))
            .await
            .unwrap_or(Ok(0))?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    match serde_json::from_slice::<Update>(&body) {
        Ok(update) if is_valid_id(&update.id) => {
            state.registry.apply(&update);
            respond_json(s, 200, &json!({"ok": true})).await
        }
        _ => {
            respond_json(
                s,
                400,
                &json!({"error": "expected {id, region, local, txt, online}"}),
            )
            .await
        }
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
