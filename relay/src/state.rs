//! Shared relay state: connected computers, pending data connections, status, limits.

use crate::alerts::Alerts;
use crate::config::Config;
use crate::io::BoxStream;
use crate::registry::{Registry, Update};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

/// A frame for a control connection's writer. `Close` is written last.
pub enum Out {
    Frame(String),
    Close(String),
}

#[derive(Clone)]
pub struct AgentHandle {
    pub session: u64,
    pub tx: mpsc::UnboundedSender<Out>,
    /// Cancelled when the computer is cut off; its client connections watch it.
    pub cut: CancellationToken,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Presence {
    Online,
    Asleep,
    Offline,
}

#[derive(Clone, Copy)]
pub struct Status {
    pub presence: Presence,
    pub since: SystemTime,
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Ok,
    Slow,
    Over,
}

struct Usage {
    start: Instant,
    window: Duration,
    bytes: u64,
    conns: u64,
}

const MINUTE: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(3600);
/// A control connection sending more frames than this a minute is cut off.
const MAX_FRAMES_PER_MIN: u64 = 600;

/// What a usage counter charges, each with its own limits (see PROTOCOL.md, Limits).
pub enum Charge<'a> {
    /// A client connection to a computer, by computer id and client source.
    Client(&'a str, &'a str),
    /// Everything one client source sends to or through this relay's computers.
    Source(&'a str),
    /// A client of the iroh relay, by source.
    Direct(&'a str),
    /// A computer's own control frames, by id.
    Frames(&'a str),
    /// Control connections, by source.
    AgentConns(&'a str),
    /// Computers new to this relay, by source.
    NewIds(&'a str),
}

/// The address a client is counted under: IPv4 as is, IPv6 by its /64, the
/// smallest block one host usually holds.
pub fn source(ip: IpAddr) -> String {
    prefix(ip, 32, 64).to_string()
}

/// `ip` with only its first `v4` or `v6` bits kept.
pub fn prefix(ip: IpAddr, v4: u8, v6: u8) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V4(a) => {
            let mask = u32::MAX.checked_shl(32 - u32::from(v4)).unwrap_or(0);
            IpAddr::V4(Ipv4Addr::from(u32::from(a) & mask))
        }
        IpAddr::V6(a) => {
            let mask = u128::MAX.checked_shl(128 - u32::from(v6)).unwrap_or(0);
            IpAddr::V6(Ipv6Addr::from(u128::from(a) & mask))
        }
    }
}

pub struct State {
    pub cfg: Config,
    pub domain: String,
    pub registry: Registry,
    pub alerts: Alerts,
    /// The in-process iroh relay's loopback address.
    pub direct_addr: SocketAddr,
    /// The port the https listener is bound to.
    pub https_port: u16,
    pub shutdown: CancellationToken,
    pub tracker: TaskTracker,
    agents: Mutex<HashMap<String, AgentHandle>>,
    pending: Mutex<HashMap<String, oneshot::Sender<BoxStream>>>,
    status: Mutex<HashMap<String, Status>>,
    usage: Mutex<HashMap<String, Usage>>,
    blocked: RwLock<HashSet<String>>,
    open_clients: AtomicUsize,
    next_session: AtomicU64,
}

/// Holds one of the --max-connections client slots.
pub struct ClientSlot(Arc<State>);

impl Drop for ClientSlot {
    fn drop(&mut self) {
        self.0.open_clients.fetch_sub(1, Ordering::Relaxed);
    }
}

pub fn frame(v: serde_json::Value) -> String {
    v.to_string()
}

pub fn close_frame(code: &str, message: &str) -> Out {
    Out::Close(frame(
        serde_json::json!({"t": "close", "code": code, "message": message}),
    ))
}

impl State {
    pub fn new(
        cfg: Config,
        domain: String,
        registry: Registry,
        alerts: Alerts,
        direct_addr: SocketAddr,
        https_port: u16,
    ) -> Self {
        Self {
            cfg,
            domain,
            registry,
            alerts,
            direct_addr,
            https_port,
            shutdown: CancellationToken::new(),
            tracker: TaskTracker::new(),
            agents: Mutex::default(),
            pending: Mutex::default(),
            status: Mutex::default(),
            usage: Mutex::default(),
            blocked: RwLock::default(),
            open_clients: AtomicUsize::new(0),
            next_session: AtomicU64::new(1),
        }
    }

    pub fn computers(&self) -> usize {
        self.agents.lock().unwrap().len()
    }

    pub fn agent(&self, id: &str) -> Option<AgentHandle> {
        self.agents.lock().unwrap().get(id).cloned()
    }

    pub fn connected_ids(&self) -> Vec<String> {
        self.agents.lock().unwrap().keys().cloned().collect()
    }

    /// Makes this session the computer's control connection, replacing any earlier one.
    pub fn register_agent(&self, id: &str, tx: mpsc::UnboundedSender<Out>) -> AgentHandle {
        let session = self.next_session.fetch_add(1, Ordering::Relaxed);
        let mut agents = self.agents.lock().unwrap();
        let old = agents.remove(id);
        let cut = match &old {
            Some(old) => old.cut.clone(),
            None => self.shutdown.child_token(),
        };
        let handle = AgentHandle { session, tx, cut };
        agents.insert(id.to_string(), handle.clone());
        drop(agents);
        if let Some(old) = old {
            let _ = old.tx.send(close_frame(
                "replaced",
                "Another connection for this computer replaced this one.",
            ));
        }
        self.set_presence(id, Presence::Online);
        handle
    }

    /// Called when a control connection ends. Returns false when another session replaced it.
    pub fn unregister_agent(&self, id: &str, session: u64) -> bool {
        let mut agents = self.agents.lock().unwrap();
        match agents.get(id) {
            Some(a) if a.session != session => return false,
            Some(_) => {
                agents.remove(id);
            }
            None => {}
        }
        drop(agents);
        let asleep = self.status(id).map(|s| s.presence) == Some(Presence::Asleep);
        if !asleep {
            self.set_presence(id, Presence::Offline);
        }
        true
    }

    /// Cuts a computer off: closes its control connection with `code` and its client connections.
    pub fn cut(&self, id: &str, code: &str, message: &str) {
        let Some(agent) = self.agents.lock().unwrap().remove(id) else {
            return;
        };
        tracing::warn!(id, code, "computer cut off");
        let _ = agent.tx.send(close_frame(code, message));
        agent.cut.cancel();
        self.set_presence(id, Presence::Offline);
    }

    pub fn status(&self, id: &str) -> Option<Status> {
        self.status.lock().unwrap().get(id).copied()
    }

    pub fn set_presence(&self, id: &str, presence: Presence) {
        let mut status = self.status.lock().unwrap();
        if status.get(id).map(|s| s.presence) != Some(presence) {
            let since = SystemTime::now();
            status.insert(id.to_string(), Status { presence, since });
        }
    }

    pub fn is_blocked(&self, id: &str) -> bool {
        self.blocked.read().unwrap().contains(id)
    }

    /// Replaces the blocklist and cuts off connected computers that are now blocked.
    pub fn set_blocklist(&self, ids: HashSet<String>) {
        *self.blocked.write().unwrap() = ids;
        for id in self.connected_ids() {
            if self.is_blocked(&id) {
                self.cut(&id, "blocked", "This computer is blocked on this relay.");
            }
        }
    }

    pub fn add_pending(&self, conn: &str, tx: oneshot::Sender<BoxStream>) {
        self.pending.lock().unwrap().insert(conn.to_string(), tx);
    }

    pub fn take_pending(&self, conn: &str) -> Option<oneshot::Sender<BoxStream>> {
        self.pending.lock().unwrap().remove(conn)
    }

    pub fn client_slot(self: &Arc<Self>) -> Option<ClientSlot> {
        let n = self.open_clients.fetch_add(1, Ordering::Relaxed);
        let slot = ClientSlot(self.clone());
        (n < self.cfg.max_connections).then_some(slot)
    }

    /// Adds to a counter and returns its level: over its limit slows, over twice refuses.
    pub fn charge(&self, charge: Charge, bytes: u64, conns: u64) -> Level {
        let cfg = &self.cfg;
        let (key, window, byte_limit, conn_limit) = match charge {
            Charge::Client(id, source) => (
                format!("client {id} {source}"),
                MINUTE,
                cfg.limit_bytes_per_min,
                cfg.limit_conns_per_min,
            ),
            Charge::Source(source) => (
                format!("source {source}"),
                MINUTE,
                cfg.limit_ip_bytes_per_min,
                cfg.limit_ip_conns_per_min,
            ),
            Charge::Direct(source) => (
                format!("direct {source}"),
                MINUTE,
                cfg.limit_bytes_per_min,
                cfg.limit_conns_per_min,
            ),
            Charge::Frames(id) => (format!("frames {id}"), MINUTE, u64::MAX, MAX_FRAMES_PER_MIN),
            Charge::AgentConns(source) => (
                format!("agent {source}"),
                MINUTE,
                u64::MAX,
                cfg.limit_agent_conns_per_min,
            ),
            Charge::NewIds(source) => (
                format!("new {source}"),
                HOUR,
                u64::MAX,
                cfg.limit_new_ids_per_hour,
            ),
        };
        let mut usage = self.usage.lock().unwrap();
        let now = Instant::now();
        let fresh = Usage {
            start: now,
            window,
            bytes: 0,
            conns: 0,
        };
        let u = usage.entry(key).or_insert(fresh);
        if now.duration_since(u.start) >= u.window {
            u.start = now;
            u.bytes = 0;
            u.conns = 0;
        }
        u.bytes = u.bytes.saturating_add(bytes);
        u.conns = u.conns.saturating_add(conns);
        let level = |used: u64, limit: u64| {
            if used > limit.saturating_mul(2) {
                Level::Over
            } else if used > limit {
                Level::Slow
            } else {
                Level::Ok
            }
        };
        level(u.bytes, byte_limit).max(level(u.conns, conn_limit))
    }

    /// Charges a client connection (`conns` 1) or its bytes to both the
    /// computer-and-source counter and the source's own.
    pub fn charge_client(&self, id: &str, source: &str, bytes: u64, conns: u64) -> Level {
        let pair = self.charge(Charge::Client(id, source), bytes, conns);
        pair.max(self.charge(Charge::Source(source), bytes, conns))
    }

    /// True while the computer is past twice its own control-frame limit.
    pub fn over_limit(&self, id: &str) -> bool {
        self.charge(Charge::Frames(id), 0, 0) == Level::Over
    }

    /// How long to pause after `n` bytes so a slowed connection runs at the per-computer limit.
    pub fn slow_delay(&self, n: u64) -> Duration {
        Duration::from_secs_f64(n as f64 * 60.0 / self.cfg.limit_bytes_per_min.max(1) as f64)
    }

    /// Drops expired counters, and computers offline past the registry TTL.
    pub fn prune(&self) {
        let now = Instant::now();
        self.usage
            .lock()
            .unwrap()
            .retain(|_, u| now.duration_since(u.start) < u.window);
        let ttl = Duration::from_secs(self.cfg.registry_ttl_secs);
        let txt_ttl = Duration::from_secs(self.cfg.txt_ttl_secs);
        self.registry.prune(ttl, txt_ttl);
        let wall = SystemTime::now();
        self.status.lock().unwrap().retain(|_, st| {
            st.presence == Presence::Online
                || wall.duration_since(st.since).unwrap_or_default() < ttl
        });
    }

    /// Updates the registry for a computer connected here.
    pub async fn publish(
        &self,
        id: &str,
        local: Vec<Ipv4Addr>,
        txt: Option<Vec<String>>,
        online: bool,
    ) -> Result<(), String> {
        let update = Update {
            id: id.to_string(),
            region: self.cfg.region.clone(),
            local,
            txt,
            online,
        };
        self.registry.publish(update).await
    }
}
