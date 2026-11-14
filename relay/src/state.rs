//! Shared relay state: connected computers, pending data connections, status, limits.

use crate::config::Config;
use crate::io::BoxStream;
use crate::registry::{Registry, Update};
use std::collections::{HashMap, HashSet};
use std::net::Ipv4Addr;
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
    window: Instant,
    bytes: u64,
    conns: u64,
}

const WINDOW: Duration = Duration::from_secs(60);

pub struct State {
    pub cfg: Config,
    pub domain: String,
    pub registry: Registry,
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
    pub fn new(cfg: Config, domain: String, registry: Registry) -> Self {
        Self {
            cfg,
            domain,
            registry,
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

    fn account(&self, id: &str, bytes: u64, conns: u64) -> Level {
        let mut usage = self.usage.lock().unwrap();
        let now = Instant::now();
        let u = usage.entry(id.to_string()).or_insert(Usage {
            window: now,
            bytes: 0,
            conns: 0,
        });
        if now.duration_since(u.window) >= WINDOW {
            *u = Usage {
                window: now,
                bytes: 0,
                conns: 0,
            };
        }
        u.bytes += bytes;
        u.conns += conns;
        let level = |used: u64, limit: u64| {
            if used > limit.saturating_mul(2) {
                Level::Over
            } else if used > limit {
                Level::Slow
            } else {
                Level::Ok
            }
        };
        let b = level(u.bytes, self.cfg.limit_bytes_per_min);
        let c = level(u.conns, self.cfg.limit_conns_per_min);
        b.max(c)
    }

    pub fn count_conn(&self, id: &str) -> Level {
        self.account(id, 0, 1)
    }

    pub fn count_bytes(&self, id: &str, n: u64) -> Level {
        self.account(id, n, 0)
    }

    /// True while the computer's current window is past twice a limit.
    pub fn over_limit(&self, id: &str) -> bool {
        self.account(id, 0, 0) == Level::Over
    }

    /// How long to pause after `n` bytes so the computer's traffic runs at its limit.
    pub fn slow_delay(&self, n: u64) -> Duration {
        Duration::from_secs_f64(n as f64 * 60.0 / self.cfg.limit_bytes_per_min.max(1) as f64)
    }

    pub fn prune_usage(&self) {
        let now = Instant::now();
        self.usage
            .lock()
            .unwrap()
            .retain(|_, u| now.duration_since(u.window) < WINDOW);
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
