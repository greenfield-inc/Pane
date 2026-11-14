//! Authoritative DNS for <D> over UDP and TCP (helper role).

use crate::agent::is_private;
use crate::id::is_valid_id;
use crate::state::State;
use hickory_proto::op::{Edns, Message, MessageType, OpCode, ResponseCode};
use hickory_proto::rr::rdata::{A, NS, SOA, TXT};
use hickory_proto::rr::{Name, RData, Record, RecordType};
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};

const TTL: u32 = 60;
const TXT_TTL: u32 = 10;

enum Lookup {
    /// The name exists; these are its records of the asked type (possibly none).
    Found(Vec<RData>),
    NxDomain,
    /// Outside <D>.
    Refused,
}

fn ns_names(state: &State) -> Vec<String> {
    if state.cfg.ns.is_empty() {
        vec![
            format!("ns1.{}", state.domain),
            format!("ns2.{}", state.domain),
        ]
    } else {
        state
            .cfg
            .ns
            .iter()
            .map(|n| n.trim_end_matches('.').to_ascii_lowercase())
            .collect()
    }
}

fn name(s: &str) -> Name {
    Name::from_ascii(format!("{s}.")).unwrap_or_else(|_| Name::root())
}

fn soa(state: &State) -> SOA {
    let ns = ns_names(state);
    SOA::new(
        name(&ns[0]),
        name(&format!("hostmaster.{}", state.domain)),
        1,
        3600,
        600,
        86400,
        TTL,
    )
}

fn known_region(state: &State, region: &str) -> bool {
    region == state.cfg.region
        || state.cfg.relays.get(region).is_some()
        || state.cfg.region_ip.get(region).is_some()
}

fn lookup(state: &State, qname: &str, qtype: RecordType) -> Lookup {
    let d = state.domain.as_str();
    let qname = qname.trim_end_matches('.').to_ascii_lowercase();
    let prefix = if qname == d {
        ""
    } else if let Some(p) = qname.strip_suffix(d).and_then(|p| p.strip_suffix('.')) {
        p
    } else {
        return Lookup::Refused;
    };
    let labels: Vec<&str> = if prefix.is_empty() {
        Vec::new()
    } else {
        prefix.split('.').collect()
    };
    let a = |ip: Option<Ipv4Addr>| ip.map(|ip| RData::A(A(ip)));
    let (addr, txt): (Option<RData>, Option<Vec<String>>) = match labels.as_slice() {
        [] => {
            let records = match qtype {
                RecordType::A => a(state.cfg.region_addr(&state.cfg.region))
                    .into_iter()
                    .collect(),
                RecordType::NS => ns_names(state)
                    .iter()
                    .map(|n| RData::NS(NS(name(n))))
                    .collect(),
                RecordType::SOA => vec![RData::SOA(soa(state))],
                _ => Vec::new(),
            };
            return Lookup::Found(records);
        }
        [ns, ..] if ns_names(state).contains(&qname) => {
            let ip = state.cfg.ns_ip.get(ns).and_then(|ip| ip.parse().ok());
            (a(ip.or(state.cfg.public_ip)), None)
        }
        [region, "relay"] if known_region(state, region) => {
            (a(state.cfg.region_addr(region)), None)
        }
        [id] if is_valid_id(id) => match state.registry.get(id) {
            Some(e) => (a(state.cfg.region_addr(&e.region)), None),
            None => return Lookup::NxDomain,
        },
        [sub, id] if is_valid_id(id) => {
            let Some(e) = state.registry.get(id) else {
                return Lookup::NxDomain;
            };
            if *sub == "_acme-challenge" {
                (None, Some(e.txt))
            } else if *sub == "files" || is_port_label(sub) {
                (a(state.cfg.region_addr(&e.region)), None)
            } else if let Some(ip) = local_address(sub) {
                (Some(RData::A(A(ip))), None)
            } else {
                return Lookup::NxDomain;
            }
        }
        _ => return Lookup::NxDomain,
    };
    let records = match qtype {
        RecordType::A => addr.into_iter().collect(),
        RecordType::TXT => txt
            .unwrap_or_default()
            .into_iter()
            .map(|v| RData::TXT(TXT::new(vec![v])))
            .collect(),
        _ => Vec::new(),
    };
    Lookup::Found(records)
}

/// `p<port>` with a port in 1..=65535.
fn is_port_label(label: &str) -> bool {
    label
        .strip_prefix('p')
        .filter(|p| !p.starts_with('0') && p.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|p| p.parse::<u16>().ok())
        .is_some_and(|p| p > 0)
}

/// `l<a>-<b>-<c>-<d>` for a private IPv4 address.
fn local_address(label: &str) -> Option<Ipv4Addr> {
    let rest = label.strip_prefix('l')?;
    let parts: Vec<u8> = rest
        .split('-')
        .map(|p| {
            if p.len() > 1 && p.starts_with('0') {
                None
            } else {
                p.parse().ok()
            }
        })
        .collect::<Option<_>>()?;
    let [a, b, c, d] = parts.as_slice() else {
        return None;
    };
    let ip = Ipv4Addr::new(*a, *b, *c, *d);
    is_private(ip).then_some(ip)
}

/// Builds the answer to one DNS query message. `None` for undecodable input.
pub fn answer(state: &State, query: &[u8], max_len: usize) -> Option<Vec<u8>> {
    let req = Message::from_vec(query).ok()?;
    if req.metadata.message_type != MessageType::Query {
        return None;
    }
    let mut resp = Message::response(req.metadata.id, req.metadata.op_code);
    resp.metadata.recursion_desired = req.metadata.recursion_desired;
    if let Some(edns) = &req.edns {
        let mut e = Edns::new();
        e.set_max_payload(1232.min(edns.max_payload().max(512)));
        resp.set_edns(e);
    }
    let code = match (req.metadata.op_code, req.queries.as_slice()) {
        (OpCode::Query, [q]) => {
            resp.add_query(q.clone());
            let qname = q.name().to_ascii();
            match lookup(state, &qname, q.query_type()) {
                Lookup::Found(records) => {
                    resp.metadata.authoritative = true;
                    let ttl = if q.query_type() == RecordType::TXT {
                        TXT_TTL
                    } else {
                        TTL
                    };
                    if records.is_empty() {
                        resp.add_authority(Record::from_rdata(
                            name(&state.domain),
                            TTL,
                            RData::SOA(soa(state)),
                        ));
                    }
                    for r in records {
                        resp.add_answer(Record::from_rdata(q.name().clone(), ttl, r));
                    }
                    ResponseCode::NoError
                }
                Lookup::NxDomain => {
                    resp.metadata.authoritative = true;
                    resp.add_authority(Record::from_rdata(
                        name(&state.domain),
                        TTL,
                        RData::SOA(soa(state)),
                    ));
                    ResponseCode::NXDomain
                }
                Lookup::Refused => ResponseCode::Refused,
            }
        }
        (OpCode::Query, _) => ResponseCode::FormErr,
        _ => ResponseCode::NotImp,
    };
    resp.metadata.response_code = code;
    let bytes = resp.to_vec().ok()?;
    if bytes.len() <= max_len {
        return Some(bytes);
    }
    let mut truncated = resp.truncate();
    truncated.metadata.truncation = true;
    truncated.to_vec().ok()
}

pub async fn serve_udp(state: Arc<State>, socket: UdpSocket) {
    let mut buf = vec![0u8; 4096];
    loop {
        let (n, from) = tokio::select! {
            _ = state.shutdown.cancelled() => return,
            r = socket.recv_from(&mut buf) => match r {
                Ok(r) => r,
                Err(_) => continue,
            },
        };
        let max = Message::from_vec(&buf[..n])
            .ok()
            .and_then(|m| m.edns.map(|e| e.max_payload() as usize))
            .unwrap_or(512)
            .clamp(512, 1232);
        if let Some(resp) = answer(&state, &buf[..n], max) {
            let _ = socket.send_to(&resp, from).await;
        }
    }
}

pub async fn serve_tcp(state: Arc<State>, listener: TcpListener) {
    loop {
        let stream = tokio::select! {
            _ = state.shutdown.cancelled() => return,
            r = listener.accept() => match r {
                Ok((s, _)) => s,
                Err(_) => continue,
            },
        };
        let state = state.clone();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(30), tcp_conn(&state, stream)).await;
        });
    }
}

async fn tcp_conn(state: &State, mut s: TcpStream) -> std::io::Result<()> {
    loop {
        let len = s.read_u16().await? as usize;
        let mut msg = vec![0u8; len];
        s.read_exact(&mut msg).await?;
        let Some(resp) = answer(state, &msg, u16::MAX as usize) else {
            return Ok(());
        };
        s.write_u16(resp.len() as u16).await?;
        s.write_all(&resp).await?;
    }
}
