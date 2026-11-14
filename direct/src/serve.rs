//! Computer side: accept QUIC connections and pipe each bidirectional stream
//! to the local TLS listener.

use std::{net::SocketAddr, time::Duration};

use iroh::{
    Endpoint, Watcher,
    endpoint::{Connection, PathList},
};
use n0_future::StreamExt;
use serde_json::json;
use tokio::net::TcpStream;

use crate::{emit, pipe};

/// "direct" or "relay" for the path the connection currently sends on.
pub fn selected_path(paths: &PathList<'_>) -> Option<(&'static str, Duration)> {
    paths
        .iter()
        .find(|p| p.is_selected())
        .map(|p| (if p.is_relay() { "relay" } else { "direct" }, p.rtt()))
}

fn ip_addrs(endpoint: &Endpoint) -> Vec<String> {
    endpoint.addr().ip_addrs().map(|a| a.to_string()).collect()
}

pub async fn run(endpoint: Endpoint, target: SocketAddr) -> Result<(), String> {
    // Give interface discovery a moment so `ready` lists real addresses.
    let mut updates = endpoint.watch_addr().stream();
    let first_ip = async {
        while let Some(addr) = updates.next().await {
            if addr.ip_addrs().next().is_some() {
                break;
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(2), first_ip)
        .await
        .ok();
    let mut addrs = ip_addrs(&endpoint);
    emit(json!({ "t": "ready", "nodeId": endpoint.id().to_string(), "addrs": addrs }));

    let watch_endpoint = endpoint.clone();
    tokio::spawn(async move {
        while updates.next().await.is_some() {
            let now = ip_addrs(&watch_endpoint);
            if now != addrs {
                addrs = now;
                emit(json!({ "t": "addrs", "addrs": addrs }));
            }
        }
    });

    while let Some(incoming) = endpoint.accept().await {
        tokio::spawn(async move {
            // A handshake fails here when the peer asks for another ALPN.
            let Ok(accepting) = incoming.accept() else {
                return;
            };
            if let Ok(conn) = accepting.await {
                handle(conn, target).await;
            }
        });
    }
    Err("endpoint closed".into())
}

async fn handle(conn: Connection, target: SocketAddr) {
    let node_id = conn.remote_id().to_string();
    let watched = conn.clone();
    let path_task = tokio::spawn(async move {
        let mut last = None;
        let mut snapshots = watched.paths_stream();
        while let Some(paths) = snapshots.next().await {
            let kind = selected_path(&paths).map(|(kind, _)| kind);
            if kind.is_some() && kind != last {
                last = kind;
                emit(json!({ "t": "peer", "nodeId": node_id, "path": kind }));
            }
        }
    });
    while let Ok((mut send, mut recv)) = conn.accept_bi().await {
        tokio::spawn(async move {
            match TcpStream::connect(target).await {
                Ok(tcp) => pipe(tcp, send, recv).await,
                Err(_) => {
                    send.reset(1u32.into()).ok();
                    recv.stop(1u32.into()).ok();
                }
            }
        });
    }
    path_task.abort();
}
