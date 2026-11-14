//! A computer's control connection: handshake, then newline-delimited JSON frames.

use crate::id::{random_b64url, verify_hello};
use crate::io::BoxStream;
use crate::registry::valid_txt;
use crate::state::{Charge, Level, Out, State, frame, source};
use serde_json::{Value, json};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const MAX_FRAME: u64 = 64 * 1024;
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const SILENCE_TIMEOUT: Duration = Duration::from_secs(75);
const SLOW_CONN_DELAY: Duration = Duration::from_secs(1);

enum ReadError {
    Closed,
    Invalid,
}

async fn read_frame<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R) -> Result<Value, ReadError> {
    let mut line = Vec::new();
    let n = r
        .take(MAX_FRAME + 1)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|_| ReadError::Closed)?;
    if n == 0 {
        return Err(ReadError::Closed);
    }
    if line.last() != Some(&b'\n') {
        return Err(if n as u64 > MAX_FRAME {
            ReadError::Invalid
        } else {
            ReadError::Closed
        });
    }
    serde_json::from_slice(&line).map_err(|_| ReadError::Invalid)
}

async fn write_line<W: AsyncWrite + Unpin>(w: &mut W, line: &str) -> std::io::Result<()> {
    w.write_all(line.as_bytes()).await?;
    w.write_all(b"\n").await?;
    w.flush().await
}

fn error(code: &str, message: &str) -> String {
    frame(json!({"t": "error", "code": code, "message": message}))
}

/// Private IPv4 addresses (RFC 1918 and CGNAT): the only ones local address names answer.
pub fn is_private(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 10
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 168)
        || (a == 100 && (64..128).contains(&b))
}

fn parse_local(v: &Value) -> Vec<Ipv4Addr> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str()?.parse::<Ipv4Addr>().ok())
        .filter(|ip| is_private(*ip))
        .take(16)
        .collect()
}

pub async fn run(state: Arc<State>, stream: BoxStream, peer: IpAddr) {
    let (rd, mut wr) = tokio::io::split(stream);
    let mut rd = BufReader::new(rd);
    let source = source(peer);
    match state.charge(Charge::AgentConns(&source), 0, 1) {
        Level::Over => {
            let message = "Too many control connections from this address; try again in a minute.";
            tracing::info!(%peer, "control connection refused: too many this minute");
            let _ = write_line(&mut wr, &error("over-limit", message)).await;
            let _ = wr.shutdown().await;
            return;
        }
        Level::Slow => tokio::time::sleep(SLOW_CONN_DELAY).await,
        Level::Ok => {}
    }

    let nonce = random_b64url::<32>();
    if write_line(&mut wr, &frame(json!({"t": "challenge", "nonce": nonce})))
        .await
        .is_err()
    {
        return;
    }
    let hello = match tokio::time::timeout(HELLO_TIMEOUT, read_frame(&mut rd)).await {
        Ok(Ok(v)) => v,
        _ => return,
    };
    let checked = (|| {
        if hello["t"] != "hello" {
            return Err(("bad-hello", "Expected a hello frame."));
        }
        if hello["v"] != 1 {
            return Err(("bad-version", "This relay speaks protocol version 1."));
        }
        let spki = hello["spki"].as_str().unwrap_or("");
        let sig = hello["sig"].as_str().unwrap_or("");
        verify_hello(spki, sig, &nonce).map_err(|m| ("bad-signature", m))
    })();
    let id = match checked {
        Ok(id) => id,
        Err((code, message)) => {
            tracing::info!(%peer, code, "control connection refused");
            let _ = write_line(&mut wr, &error(code, message)).await;
            let _ = wr.shutdown().await;
            return;
        }
    };
    let refusal = if state.is_blocked(&id) {
        Some(("blocked", "This computer is blocked on this relay."))
    } else if state.over_limit(&id) {
        Some((
            "over-limit",
            "This computer sent too many control frames; try again in a minute.",
        ))
    } else if state.registry.get(&id).is_some() {
        None
    } else if state.registry.is_full() {
        Some((
            "full",
            "This relay has no room for new computers; try another relay.",
        ))
    } else if state.charge(Charge::NewIds(&source), 0, 1) != Level::Ok {
        Some((
            "over-limit",
            "Too many new computers from this address this hour; try again later.",
        ))
    } else {
        None
    };
    if let Some((code, message)) = refusal {
        tracing::info!(id, %peer, code, "control connection refused");
        let _ = write_line(&mut wr, &error(code, message)).await;
        let _ = wr.shutdown().await;
        return;
    }
    let name: String = hello["name"]
        .as_str()
        .unwrap_or("")
        .chars()
        .take(60)
        .collect();
    let mut local = parse_local(&hello["local"]);

    let welcome =
        json!({"t": "welcome", "id": id, "domain": state.domain, "region": state.cfg.region});
    if write_line(&mut wr, &frame(welcome)).await.is_err() {
        return;
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    let handle = state.register_agent(&id, tx.clone());
    let _ = state.publish(&id, local.clone(), None, true).await;
    tracing::info!(id, %peer, name_len = name.len(), "computer connected");

    // The writer drains queued frames; a Close frame is written last and ends the session.
    let done = CancellationToken::new();
    let writer = {
        let done = done.clone();
        tokio::spawn(async move {
            loop {
                let out = tokio::select! {
                    _ = done.cancelled() => break,
                    out = rx.recv() => out,
                };
                match out {
                    Some(Out::Frame(line)) => {
                        if write_line(&mut wr, &line).await.is_err() {
                            break;
                        }
                    }
                    Some(Out::Close(line)) => {
                        let _ = write_line(&mut wr, &line).await;
                        break;
                    }
                    None => break,
                }
            }
            let _ = wr.shutdown().await;
            done.cancel();
        })
    };

    let reason = loop {
        let read = tokio::select! {
            _ = done.cancelled() => break "closed by relay",
            _ = state.shutdown.cancelled() => {
                let _ = tx.send(crate::state::close_frame("shutdown", "The relay is restarting."));
                let _ = tokio::time::timeout(Duration::from_secs(2), done.cancelled()).await;
                break "shutdown";
            }
            r = tokio::time::timeout(SILENCE_TIMEOUT, read_frame(&mut rd)) => r,
        };
        let v = match read {
            Err(_) => break "silent for 75 s",
            Ok(Err(ReadError::Closed)) => break "closed by computer",
            Ok(Err(ReadError::Invalid)) => break "invalid frame",
            Ok(Ok(v)) => v,
        };
        if state.charge(Charge::Frames(&id), 0, 1) == Level::Over {
            state.cut(&id, "over-limit", "Too many control frames this minute.");
            continue;
        }
        let req = v.get("req").cloned().unwrap_or(Value::Null);
        match v["t"].as_str().unwrap_or("") {
            "ping" => {
                let _ = tx.send(Out::Frame(frame(json!({"t": "pong"}))));
            }
            "local" => {
                local = parse_local(&v["local"]);
                let _ = state.publish(&id, local.clone(), None, true).await;
            }
            "sleep" => {
                state.set_presence(&id, crate::state::Presence::Asleep);
                tracing::info!(id, "computer going to sleep");
            }
            "txt" => {
                let values: Option<Vec<String>> = v["values"]
                    .as_array()
                    .and_then(|a| a.iter().map(|s| s.as_str().map(String::from)).collect());
                let answer = match values {
                    Some(values) if valid_txt(&values) => {
                        match state.publish(&id, local.clone(), Some(values), true).await {
                            Ok(()) => json!({"t": "ok", "req": req}),
                            Err(e) => {
                                json!({"t": "error", "req": req, "code": "registry", "message": e})
                            }
                        }
                    }
                    _ => json!({"t": "error", "req": req, "code": "bad-request",
                        "message": "values must be at most 2 strings of at most 64 bytes"}),
                };
                let _ = tx.send(Out::Frame(frame(answer)));
            }
            "alert" => {
                let (state, tx, id) = (state.clone(), tx.clone(), id.clone());
                tokio::spawn(async move {
                    let mut answer = state.alerts.deliver(&id, &v).await;
                    answer["req"] = req;
                    let _ = tx.send(Out::Frame(frame(answer)));
                });
            }
            _ => {}
        }
    };
    done.cancel();
    let _ = writer.await;
    if state.unregister_agent(&id, handle.session) {
        let _ = state.publish(&id, local, None, false).await;
    }
    tracing::info!(id, %peer, reason, "computer disconnected");
}
