# Runpane Cloud: daemon surface for the coordinator

A cloud Session is a normal headless Pane daemon on a provider sandbox. The coordinator (`runpane cloud`)
talks to it through `GET /health`, `runpane:cloud:safe-to-stop` (with `runpane:cloud:stop-lease:release`) and
`runpane:cloud:upgrade`, over the usual `POST /invoke` with its paired client token; it sends the same token to
`/health`. The laptop CLI adds `runpane:cloud:coordinator-client:pair|revoke` with its full-access token (see the
coordinator doc). Code: `main/src/daemon/cloud/`.

## `GET /health`: version and readiness

Anyone may call it, as before, but without a valid paired-client token (`Authorization: Bearer <token>`; any
client, the coordinator's scoped one included) it answers only `{ "ok": true, "status": "ready", "transport":
"http+sse" }`: `status` only says the HTTP server answers. That is all the desktop and phone clients' reachability
check needs. A paired client, or any caller when pairing is off, also gets the build and readiness:

```json
{
  "version": "2.4.141-rc.20260930064034.g44c801fe",
  "gitCommit": "44c801fe",
  "startedAt": "2026-09-30T06:58:03.159Z",
  "readiness": {
    "state": "ready",
    "daemon": "ready",
    "agentRestore": "none",
    "agents": { "expected": 1, "ready": 1, "starting": 0, "blocked": 0, "notRunning": 0 }
  }
}
```

- `agents` counts the agent panels (Claude, Codex, ...) of non-archived Panes. `ready` means the terminal runs and
  the agent shows idle or working chrome; `blocked` means it waits on a person (a trust or permission prompt);
  `starting` means the terminal runs but the agent is not detected yet; `notRunning` means no terminal is behind the panel.
- `readiness.state`:
  - `starting` while bootstrap runs, while agent restore is `pending`, or while any agent panel is `starting`;
  - `degraded` when restore finished (`done`, not lazy) but some agent panels are not running;
  - `ready` otherwise.
- A wake is finished when `readiness.state` is no longer `starting` (and `version` matches the pin).
- The agent-restore step reports its progress with `setAgentRestorePhase('pending' | 'done', { lazy? })` from
  `main/src/daemon/cloud/readiness.ts`. Without it, `agentRestore` stays `none` and readiness follows live panels only.

## `runpane:cloud:safe-to-stop`

A provider stop is a power-off after a disk snapshot, with no SIGTERM (boat snapshots 3.6–4.7 s after the
stop call). The daemon therefore has to say whether stopping is safe **and** make its state durable before the coordinator
calls stop.

Request (all optional): `{ "flush": "if-safe" | "always" | "never", "recentOutputMs": 120000, "clientWindowMs": 900000, "stopLeaseMs": 60000 }`.

It refuses while any of these holds, and lists every one it finds:

| condition | when |
|---|---|
| `agent-working` | an agent panel's detected state is working |
| `recent-terminal-output` | any terminal printed within `recentOutputMs` (default 2 min) |
| `lock-held` | a named lock (`runpane lock`) is held |
| `watcher-active` | a `runpane:workspace:wait` or `runpane:panels:wait` call is running, or one returned in the last 30 s (a watch loop between calls) |
| `pr-checks-pending` | a Session member's open PR has checks still running (the PR monitor polls first if its last round is over 60 s old) |
| `user-client-attached` | a user client has an open `/events` stream, or called `/invoke` within `clientWindowMs` (default 15 min) |
| `call-in-flight` | with `stopLeaseMs` only: another call to this daemon (other than a wait) was still running when the lease went up |
| `flush-failed` | the flush ran but could not be verified durable (`flush.failures` says why) |

Peers (paired records with `scope: 'peer'`) never count: not their waits, streams or calls. Every `runpane:cloud:*`
call is exempt too, so the coordinator's own polling never keeps a Session awake.

With `flush: "if-safe"` (the default), a safe answer comes only after the daemon has checkpointed the SQLite WAL
(`wal_checkpoint(TRUNCATE)`), fsynced the database, its `-wal` file, every file at the top of the Pane directory and
the directory itself, refreshed the tailscaled-state backup (cloud sandboxes only), and run `sync -f` on its
filesystem. `flush.durable` is true only when every one of those steps succeeded; a failed step is listed in
`flush.failures` and turns the answer unsafe with a `flush-failed` blocker. A checkpoint that a reader kept busy
still counts once the remaining `-wal` file is fsynced. `always` flushes even when blocked (a stop the user asked
for); `never` only checks.

```json
{ "ok": true, "safe": true, "checkedAt": "...", "version": "...", "blockers": [],
  "flush": { "walCheckpoint": { "busy": 0, "log": 12, "checkpointed": 12 }, "fsynced": ["..."], "syncedFilesystem": true, "durable": true, "failures": [], "durationMs": 40 },
  "stopLease": { "expiresAt": "...", "ms": 60000 } }
```

**The stop lease.** Between a safe answer and the provider's snapshot, anything that starts on the daemon (a
submit from the desktop or a peer, `runpane --host`, a new agent turn) would be lost or half-written. So a
request with `stopLeaseMs` (at most 120000) fences the daemon: the lease goes up before the check, and while it
holds, every other call from every origin (paired clients, peers, the local socket) is refused with
`ERR_SESSION_STOPPING` (HTTP 503, retryable), except `runpane:cloud:safe-to-stop` and
`runpane:cloud:stop-lease:release`. A call that started before the lease and is still running blocks the answer
(`call-in-flight`). An unsafe answer drops the lease at once; a safe one returns it as `stopLease`. The coordinator
calls the provider's stop within the lease, or calls `runpane:cloud:stop-lease:release` when it does not stop;
otherwise the lease lapses after `stopLeaseMs`. The lease is in memory, so a daemon restart drops it. Agents and
commands already running are not fenced: the answer is safe only when none are working. The `runpane` CLI
treats `ERR_SESSION_STOPPING` like a sleeping host: a submit waits for the stop and wakes the host through the
coordinator (same idempotency key); anything else fails with `ERR_RUNPANE_HOST_STOPPING`.

Without `stopLeaseMs` nothing is fenced: anything written after the answer can still be lost until the
provider's snapshot point.

Inside the sandbox the same check runs through the local socket:
`runpane cloud safe-to-stop [--force] [--dry-run] [--json]` (exit 0 safe, 3 blocked, 1 error).

## `runpane:cloud:upgrade`: version pin on wake

Headless daemons never update themselves (`versionChecker` runs only on the desktop). The Session, not the
caller, decides what it may be upgraded to: the laptop CLI writes the coordinator's pin into each Session as
`/etc/rp-cloud/pane-pin.json` (`{version, url, sha256}`, root:root 0644; `rp-bootstrap.sh pin-pane`) at
`runpane cloud new`, `wake` and `repair`, and on every awake Session at `coordinator deploy` (`--no-pin`
removes it). After a wake, when `/health.version` differs from the pinned version, the coordinator calls:

```json
{ "channel": "runpane:cloud:upgrade", "args": [{ "version": "<pinned>", "url": "https://.../pane_<pinned>_amd64.deb", "sha256": "<64 hex>" }] }
```

- Same version already running: `{ ok: true, upgraded: false }`.
- A request that is not exactly the Session's pin (version, url and sha256), or a Session without a pin, is
  refused with `ERR_CLOUD_UPGRADE_NOT_PINNED`; nothing is downloaded. So the coordinator's token can relay the
  pin but can't choose a package, which `apt-get` would install as root. A pin file that isn't owned by root,
  or is group- or world-writable, is refused (`_PIN_UNSAFE`), as is one that doesn't decode (`_PIN_INVALID`).
- A pin older than `2.4.141-rc.20260930080320` in Debian version order is refused (`_TOO_OLD`): an older Pane
  ignores client scopes, so the coordinator's token would become a full-access client. `apt-get` runs with
  `--allow-downgrades`, so only downgrades to a pin at or above that floor are possible.
- Otherwise the daemon downloads the package (https only) into `<pane dir>/cloud-upgrades/`, checks its sha256, and
  starts a transient `systemd-run --user` job that runs `sudo -n apt-get install` on it and restarts the daemon's own
  systemd user unit (read from `/proc/self/cgroup`). It answers `{ ok: true, upgraded: "scheduled", from, to }`
  before the restart; the coordinator then polls `/health` until `version` equals the pin and readiness is not `starting`.
- Errors carry a code at the start of the message: `ERR_CLOUD_UPGRADE_BAD_REQUEST`, `_CHECKSUM`, `_DOWNLOAD`,
  `_NO_SERVICE` (not under systemd), `_UNSUPPORTED` (not Linux), `_SPAWN`. An older daemon answers `ERR_UNKNOWN_CHANNEL`.
- `debUrl` is accepted as an alias of `url`.

## `runpane:ports:*`: Session ports (for clients, not the coordinator)

User clients (Pane desktop, the phone app, `runpane --host`, `runpane cloud port`) and agents in the Session
call these; the coordinator and peers are refused like every other channel outside their scope. Code:
`main/src/daemon/cloud/ports/`, types in `shared/types/sessionPorts.ts`. Every daemon registers them; off a
Runpane Cloud Session (no `/etc/rp-cloud/serve.json`) `list` answers `available: false` and the others fail
with `ERR_PORTS_UNAVAILABLE`, so a laptop's tailnet name is never touched. On a new Session the bootstrap writes
that marker after the daemon's first start, so a daemon whose user has the bootstrap's `~/.runpane-cloud`
directory looks for it every 2 s for up to 15 minutes; any other daemon (desktop, self-hosted) never polls.

| Channel | Args | Result |
|---|---|---|
| `runpane:ports:list` | `[{ verify?: boolean }]` | `{ ok, available, unavailableReason?, host?, scheme, autoOpen, ports: SessionPort[], suggested: SuggestedPort[], manifests: [{repo, ok, error?, count}] }` |
| `runpane:ports:open` | `[{ port, name?, httpsPort?, path?, yes?, scheme?: "auto"\|"https"\|"http" }]` | `{ ok, port: SessionPort, alreadyOpen, replaced?: {httpsPort, was} }` |
| `runpane:ports:close` | `[{ target: number\|string }]` (local port or name) | `{ ok, closed: SessionPort \| null }` |
| `runpane:ports:configure` | `[{ autoOpen: boolean }]` | `{ ok, autoOpen }` |

- `SessionPort`: `{ name, port, httpsPort, url, scheme, path, source: "user"|"manifest"|"auto", repo?, createdAt,
  status: "serving"|"missing"|"error", detail?, reachable? }` (`reachable` only with `verify`; 502 counts as not
  reachable). `SuggestedPort`: `{ port, address, process?, pid?, paneId?, panelId?, detectedAt }`.
- Errors (`code`): `ERR_PORTS_CONFLICT` (another Serve entry holds the tailnet port; retry with `yes: true` after
  the user agrees), `ERR_PORTS_RESERVED` (443 or the daemon's port), `ERR_PORTS_IN_USE` (another published
  port uses that tailnet port, or this port is published elsewhere), `ERR_PORTS_INVALID`, `ERR_PORTS_UNAVAILABLE`.
- Event: `runpane:ports:changed` with the `list` result (never verified) after every change and whenever the
  suggestions change.
- Mechanics: `tailscale serve --bg --https=<httpsPort> http://127.0.0.1:<port>` as the node's operator (`sudo -n`
  when that is refused); the state is `~/.runpane-cloud/ports.json` (0600, atomic writes). A reconcile runs
  once Tailscale is `Running` after the daemon starts (so at every boot and wake), every minute, and when the
  set of repositories changes. It reads each repository's `.runpane/ports.json`, re-applies lost entries, never
  removes a Serve entry it did not make, and at boot requests every URL and logs the answer. Detection reads
  `/proc/net/tcp{,6}` every 5 s and keeps listeners whose process descends from a panel's PTY.

## Agent notes for Session ports

At start, a daemon on a Runpane Cloud Session (`/etc/rp-cloud/serve.json` exists) keeps a marked block
(`<!-- runpane-cloud-ports:start -->` … `<!-- runpane-cloud-ports:end -->`) in `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md`. The block tells agents to publish what they serve with `runpane port open <port> --name
<name>` and to paste the printed `https://` URL instead of a `localhost` one. The daemon writes it only when the
text differs, keeps everything else in those files (including the CLI's `runpane-cloud-github` and
`runpane-cloud-secrets` blocks), and never writes it off a Session. Because the daemon writes it, an upgraded
Session gets the current text without `runpane cloud repair`. Code: `main/src/daemon/cloud/sessionAgentNotes.ts`.

## `runpane:cloud:agent-notes`: the user's guardrails

The user's own rules for agents (`agentNotes.guardrails` in their `~/.config/runpane-cloud/settings.json`;
Pane ships none) reach a Session through this channel, called by `runpane cloud new`, `wake` and `notes
add|remove|push` with the saved user token (the coordinator's scoped token can't call it):

```json
{ "channel": "runpane:cloud:agent-notes", "args": [{ "guardrails": ["Ask before running destructive database operations."] }] }
```

The daemon stores the list in `~/.runpane-cloud/agent-notes.json` (0600) and writes it as a
`<!-- runpane-cloud-guardrails:start -->` ... `:end -->` block next to the ports block, now and at every
daemon start (boot, wake, upgrade). The list replaces the previous one, and an empty list removes the
block. Each entry is one line of at most 500 characters without `<!--` or `-->` (they delimit the blocks), and a list holds at most 20. Without `guardrails`
the channel answers the stored list. It answers `{ ok, guardrails, changedFiles }` and refuses off a Session
(`ERR_AGENT_NOTES_UNAVAILABLE`) or for bad input (`ERR_AGENT_NOTES_INVALID`).
