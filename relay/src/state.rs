//! Shared relay state: connected computers, pending data connections, status, limits.

use crate::alerts::Alerts;
use crate::config::Config;
use crate::eab::Eab;
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
    count: u64,
}

/// A token bucket of bytes that refills at `rate` a second and holds one second's worth.
/// Taking more than it holds leaves it in debt, and the sender waits the debt out.
struct Bucket {
    tokens: f64,
    rate: f64,
    at: Instant,
}

impl Bucket {
    fn refill(&mut self, now: Instant) {
        let earned = now.duration_since(self.at).as_secs_f64() * self.rate;
        self.tokens = (self.tokens + earned).min(self.rate);
        self.at = now;
    }
}

const MINUTE: Duration = Duration::from_secs(60);
const HOUR: Duration = Duration::from_secs(3600);
const DAY: Duration = Duration::from_secs(86_400);
/// A control connection sending more frames than this a minute is cut off.
const MAX_FRAMES_PER_MIN: u64 = 600;

/// What a usage counter counts, each with its own limit (see PROTOCOL.md, Limits).
#[derive(Clone, Copy)]
pub enum Charge<'a> {
    /// Client connections to a computer, by computer id and client source.
    Client(&'a str, &'a str),
    /// Client connections from one source to any of this relay's computers.
    Source(&'a str),
    /// A client of the iroh relay, by source.
    Direct(&'a str),
    /// A computer's own control frames, by id.
    Frames(&'a str),
    /// Control connections, by source.
    AgentConns(&'a str),
    /// Computers new to this relay, by source.
    NewIds(&'a str),
    /// Google Trust Services EAB keys, by computer id.
    Eab(&'a str),
    /// Google Trust Services EAB keys across all of this relay's computers.
    EabRelay,
}

/// The address a client is counted under: IPv4 as is, IPv6 by its /64, the
/// smallest block one host usually holds.
pub fn source(ip: IpAddr) -> String {
    prefix(ip, 32, 64).to_string()
}

/// The address control connections and new computers are counted under: IPv4
/// as is, IPv6 by its /56, the block an ISP usually hands one home or small site.
pub fn registration_source(ip: IpAddr) -> String {
    prefix(ip, 32, 56).to_string()
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
    pub eab: Eab,
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
    buckets: Mutex<HashMap<String, Bucket>>,
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
        eab: Eab,
        direct_addr: SocketAddr,
        https_port: u16,
    ) -> Self {
        Self {
            cfg,
            domain,
            registry,
            alerts,
            eab,
            direct_addr,
            https_port,
            shutdown: CancellationToken::new(),
            tracker: TaskTracker::new(),
            agents: Mutex::default(),
            pending: Mutex::default(),
            status: Mutex::default(),
            usage: Mutex::default(),
            buckets: Mutex::default(),
            blocked: RwLock::default(),
            open_clients: AtomicUsize::new(0),
            next_session: AtomicU64::new(1),
        }
    }

    /// A `--dev` relay's state with default limits and no DNS helpers, for unit tests.
    #[cfg(test)]
    pub fn for_tests() -> Self {
        use clap::Parser;
        let cfg = Config::parse_from(["pane-relay", "--dev"]);
        let alerts = Alerts::load(&cfg).unwrap();
        let registry = Registry::new(&[], None, None, 10).unwrap();
        let direct = "127.0.0.1:1".parse().unwrap();
        Self::new(cfg, "pane.localhost".into(), registry, alerts, direct, 8443)
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

    /// A counter's key, window and limit.
    fn counter(&self, charge: Charge) -> (String, Duration, u64) {
        let cfg = &self.cfg;
        match charge {
            Charge::Client(id, source) => (
                format!("client {id} {source}"),
                MINUTE,
                cfg.limit_conns_per_min,
            ),
            Charge::Source(source) => (
                format!("source {source}"),
                MINUTE,
                cfg.limit_ip_conns_per_min,
            ),
            Charge::Direct(source) => (format!("direct {source}"), MINUTE, cfg.limit_conns_per_min),
            Charge::Frames(id) => (format!("frames {id}"), MINUTE, MAX_FRAMES_PER_MIN),
            Charge::AgentConns(source) => (
                format!("agent {source}"),
                MINUTE,
                cfg.limit_agent_conns_per_min,
            ),
            Charge::NewIds(source) => (format!("new {source}"), HOUR, cfg.limit_new_ids_per_hour),
            Charge::Eab(id) => (format!("eab {id}"), DAY, cfg.limit_eab_per_day),
            Charge::EabRelay => ("eab *".to_string(), HOUR, cfg.limit_eab_per_hour),
        }
    }

    /// Adds `n` to a counter and returns its level: over its limit slows, over twice refuses.
    pub fn charge(&self, charge: Charge, n: u64) -> Level {
        let (key, window, limit) = self.counter(charge);
        let mut usage = self.usage.lock().unwrap();
        let now = Instant::now();
        let fresh = Usage {
            start: now,
            window,
            count: 0,
        };
        let u = usage.entry(key).or_insert(fresh);
        if now.duration_since(u.start) >= u.window {
            u.start = now;
            u.count = 0;
        }
        u.count = u.count.saturating_add(n);
        if u.count > limit.saturating_mul(2) {
            Level::Over
        } else if u.count > limit {
            Level::Slow
        } else {
            Level::Ok
        }
    }

    /// Takes back one count, for a charge whose work failed before it was used.
    pub fn refund(&self, charge: Charge) {
        let (key, _, _) = self.counter(charge);
        if let Some(u) = self.usage.lock().unwrap().get_mut(&key) {
            u.count = u.count.saturating_sub(1);
        }
    }

    /// Counts a new client connection against both the computer-and-source
    /// counter and the source's own.
    pub fn charge_client(&self, id: &str, source: &str) -> Level {
        let pair = self.charge(Charge::Client(id, source), 1);
        pair.max(self.charge(Charge::Source(source), 1))
    }

    /// True while the computer is past twice its own control-frame limit.
    pub fn over_limit(&self, id: &str) -> bool {
        self.charge(Charge::Frames(id), 0) == Level::Over
    }

    /// Takes `bytes` a client connection carried, and returns how long it waits
    /// before the next so its address holds its rates: per computer, and across all computers.
    pub fn pace_client(&self, id: &str, source: &str, bytes: u64) -> Duration {
        let cfg = &self.cfg;
        let pair = self.take(
            format!("client {id} {source}"),
            cfg.limit_mbit_per_sec,
            bytes,
        );
        pair.max(self.take(format!("source {source}"), cfg.limit_ip_mbit_per_sec, bytes))
    }

    /// Like `pace_client`, for a client of the iroh relay: its own rate, inside the
    /// source's rate across all computers.
    pub fn pace_direct(&self, source: &str, bytes: u64) -> Duration {
        let cfg = &self.cfg;
        let own = self.take(format!("direct {source}"), cfg.limit_mbit_per_sec, bytes);
        own.max(self.take(format!("source {source}"), cfg.limit_ip_mbit_per_sec, bytes))
    }

    fn take(&self, key: String, mbit_per_sec: u64, bytes: u64) -> Duration {
        let rate = mbit_per_sec.max(1) as f64 * 125_000.0;
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap();
        let b = buckets.entry(key).or_insert(Bucket {
            tokens: rate,
            rate,
            at: now,
        });
        b.refill(now);
        b.tokens -= bytes as f64;
        if b.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-b.tokens / rate)
        }
    }

    /// Drops expired counters, and computers offline past the registry TTL.
    pub fn prune(&self) {
        let now = Instant::now();
        self.usage
            .lock()
            .unwrap()
            .retain(|_, u| now.duration_since(u.start) < u.window);
        self.buckets.lock().unwrap().retain(|_, b| {
            b.refill(now);
            b.tokens < b.rate
        });
        let ttl = Duration::from_secs(self.cfg.registry_ttl_secs);
        let unproven_ttl = Duration::from_secs(self.cfg.unproven_ttl_secs);
        let txt_ttl = Duration::from_secs(self.cfg.txt_ttl_secs);
        self.registry.prune(ttl, unproven_ttl, txt_ttl);
        // A status row lasts as long as its computer's registry entry.
        self.status
            .lock()
            .unwrap()
            .retain(|id, st| st.presence == Presence::Online || self.registry.get(id).is_some());
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

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    // The integration tests reach the relay only from 127.0.0.1 and ::1, so the
    // IPv6 block that registrations count under is checked here, on the counter itself.
    #[test]
    fn new_computers_from_one_ipv6_slash56_share_one_limit() {
        let cfg = Config::parse_from(["pane-relay", "--dev", "--limit-new-ids-per-hour", "20"]);
        let alerts = Alerts::load(&cfg).unwrap();
        let registry = Registry::new(&[], None, None, 10).unwrap();
        let direct = "127.0.0.1:1".parse().unwrap();
        let eab = Eab::load(&cfg).unwrap();
        let state = State::new(
            cfg,
            "pane.localhost".into(),
            registry,
            alerts,
            eab,
            direct,
            8443,
        );
        let new_id = |ip: &str| {
            let source = registration_source(ip.parse().unwrap());
            state.charge(Charge::NewIds(&source), 1)
        };
        // 2001:db8:0:<n>::1 for n in 0..20: twenty /64s inside 2001:db8::/56.
        for n in 0..20 {
            assert_eq!(new_id(&format!("2001:db8:0:{n:x}::1")), Level::Ok);
        }
        assert_ne!(new_id("2001:db8:0:ff::1"), Level::Ok);
        // The next /56 has its own count.
        assert_eq!(new_id("2001:db8:0:100::1"), Level::Ok);
    }
}
