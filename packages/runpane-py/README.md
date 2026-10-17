# runpane

Install or configure Pane from PyPI.

The package does not include the Pane desktop runtime. It downloads the correct
Pane release artifact only when you run `runpane install` or `runpane update`.

The same CLI also drives a running Pane app: list and add repos, create and
manage panes, read and send input to panels, manage sessions, and follow events
with `runpane watch`. See the
[runpane CLI contract](https://github.com/greenfield-inc/Pane/blob/main/docs/RUNPANE_CLI_CONTRACT.md) for every command.

`runpane panes adopt` is not in the Python CLI yet; use the npm package for it.

## Quick Start

Run the guided setup:

```bash
pipx run runpane
```

Persistent install:

```bash
python -m pip install runpane
python -m runpane setup
```

The wizard can install Pane on this machine, configure this machine as a remote
host, update Pane, or run diagnostics.

## MCP Server

The Pane MCP server (`runpane mcp`) ships in the npm package and inside the
Pane desktop app, not in this package. Run it with Node:
`npx --yes runpane@latest mcp`.

## Advanced

### Explicit Commands

```bash
pipx run runpane setup
pipx run runpane install client
pipx run runpane install daemon --label "My Server"
pipx run runpane update --pane-only
pipx run runpane doctor
```

`runpane install daemon` installs Pane and then invokes the installed executable
with `--remote-setup`, preserving the `pane-remote://...` connection-code output.

### Python Runners

One-shot execution:

```bash
uvx runpane@latest
```

Persistent install:

```bash
python -m pip install runpane
python -m runpane setup

pipx install runpane
runpane setup
```

### Commands

```bash
runpane
runpane setup
runpane install
runpane install client
runpane install daemon
runpane update
runpane version
runpane doctor
runpane --help
```

### Independent updates

`runpane update` updates both the running Pane installation on this machine and
the CLI installation that received the command. Use `--pane-only` or
`--cli-only` to select one; these flags are mutually exclusive. `--version`
continues to select the requested release. A managed CLI update stays pinned
when an older Pane starts again. Global npm and supported pip environments are
updated through their owning package manager; changing the bundled shim does
not count as updating either package.

Run `runpane update --dry-run --json` to inspect the machine, executable, CLI
owner, and supervisor capability. App updates require a running host supporting
the continuity protocol and a release with a matching `continuity.json` manifest.
Both the running app and the requested target must support this protocol.
Existing 2.4.182 releases do not provide this upgrade path; install a
continuity-capable release manually first. See the
[prerequisites and recovery guide](../../docs/UPDATE_RECOVERY.md). Cached/local npm installs,
system-managed Linux packages, non-stable/daemon installer options, custom download
directories, missing standalone Node, and unwritable targets
are refused before downtime. Python delegates to the managed engine installed
by Pane and records the invoking Python environment.

The command returns an operation ID after the independent helper acknowledges
startup. That is acceptance, not completion. The
[status fields, terminal phases and exit codes](../../docs/UPDATE_RECOVERY.md#status-and-exit-codes)
distinguish installed components from a healthy host and restored panels. Use
`runpane update --status <id> --wait --json` with the same `--pane-dir` to inspect
installed components, host health, and each panel's restoration outcome. A
current-user launchd, Task Scheduler, or systemd service owns the helper; its
code and standalone runtime are staged outside the files being replaced.

Settings installation uses this same operation; downloaded legacy updates never
install implicitly on quit. Before downtime, Pane fences new mutations, waits for
in-flight work, checks snapshot readability and capacity on every affected volume,
and records a clean-shutdown acknowledgment after persistence and service cleanup.
A forced exit or missing acknowledgment never authorizes installation.

The helper stages and verifies packages before shutdown, preserves a data and
browser-profile snapshot, replaces the identified installation, and checks the
new host's version, endpoint/auth configuration, and data/profile identity.
Active agents receive only their recorded resume command with the saved launch
profile. A panel reports `resumed` only after the harness confirms that conversation
identity and readiness; a launched shell or readiness timeout is not confirmation.
Harnesses that cannot provide fresh identity evidence report `needs-attention`. It never sends a prompt or `continue`, guesses a conversation, or
replays an uncertain action. Idle/completed/approval-blocked panels stay stopped;
ambiguous active runs report `needs-attention`. Review a stopped panel before
explicitly resuming it. A failed post-shutdown operation retains its lock and
snapshot for inspection; it never downgrades a migrated database automatically.

Updates need the current interactive login. Logout/reboot recovery and a
`needs-attention` operation require inspecting durable status before further
installation work. To choose another machine explicitly, run
`runpane workspace <machine> exec -- runpane update`; the UI's selected host does
not change the default update target.

### Installer options

The following options apply to `install client` and `install daemon`. For
`update`, `--version` and `--dry-run` apply; `--pane-path` only verifies the
running executable and cannot select another installation. `--download-dir`
is refused; `--format` must be `auto` or the native update format (`zip` on
macOS, `exe` on Windows, `appimage` on Linux).


```bash
--version <latest|vX.Y.Z>
--format <auto|appimage|deb|dmg|zip|exe>
--download-dir <path>
--pane-path <path>
--dry-run
--verbose
```

Daemon setup also forwards Pane remote-host options:

```bash
--label <name>
--prefer-tunnel <tailscale|ssh|manual|auto>
--print-only
```

### Watching the Workspace

`runpane watch` waits for workspace transitions from the Pane daemon without
polling. Under `--follow` it prints one line per event: `READY` (a turn ended),
`BLOCKED` (the agent is waiting on a human), `IDLE`, `STUCK` (real unsubmitted
composer text; an agent prompt suggestion never counts), `NEW`, `GONE`, `EXIT`,
and optional `HEARTBEAT` lines when enabled with `--heartbeat`.

```bash
runpane watch --self-test
runpane watch --follow
```

`--follow` has one default cadence: READY settles for 3 minutes, BLOCKED
for 30 seconds, and non-urgent events batch every 10 minutes. IDLE starts at
10 minutes and backs off to 30 minutes, 1 hour, 3 hours, then daily. Heartbeats
are off. WATCH OK prints once when armed; WATCH EXPIRED and exit 0 end a watch
after 3 quiet hours. Meaningful events reset expiry; IDLE and replay do not.

Individual duration overrides accept `30s`, `3m`, `3h`, or `0`: `--ready-settle`, `--blocked-settle`,
`--min-interval`, `--idle-after`, `--expire-after`, `--heartbeat`, and
watch `--timeout-ms` (for example, `--until-event --timeout-ms 30s`).
`--expire-after 0` disables natural expiry. Bare values retain milliseconds,
except heartbeat's legacy seconds. `--json` selects NDJSON; otherwise lines.

`--present` and `--profile` were removed. Use individual timing flags such as
`--ready-settle 1m --blocked-settle 15s --min-interval 2m` to override the defaults.

```bash
runpane watch --session <session-id> --follow --json
runpane watch --session <session-id> --follow --ready-settle 1m --blocked-settle 15s --min-interval 2m --json
runpane watch --pane <pane-id> --until-event --json
```

Session membership changes need no re-arm. Named cursors survive daemon
restarts; the journal and PR baselines are saved together. RESET/DROPPED mean
refresh the overview; replayed baseline entries never mean a new READY.
`--until-event` waits for REPORT, BLOCKED, EXIT or GONE by default and exits 0
when one arrives, immediately without follow settling or batching. A harness
that consumes a named follow stream gets its cadence; a process-exit waiter
keeps these immediate single-event semantics. Cadence requires a named consumer
(explicit `--as` or the name assigned by follow). `--follow --since <generation>`
has no consumer name and also bypasses settling and batching. Named `--as`
cannot be combined with numeric `--since`; switching only the wait mode does
not enable cadence for a numeric generation/epoch cursor.
Override `--kinds` for PR events. Its `--timeout-ms` is a
total deadline (exit 124); under follow it bounds each daemon request.

REPORT remains the completion signal: workers use `runpane report --state
ready|blocked|failed|done --summary-file <path>`, adding a PR/head and a question
when blocked. READY alone is activity evidence. Read the full report with
`runpane agents status --panel <id> --json`. Resume stopped workers in the same
panel with `runpane panels resume --panel <id> --wait-ready --yes --json`.

Do not pipe follow through `head` or `grep -m1` to wait. Run `--until-event` as
a supported background task, act on its events, then re-arm with its cursor.
Never sleep-poll your own background task output. WATCH ERROR/nonzero exit
means failure: report it and re-arm once. A superseded cursor means keep the
replacement. A normal expiry means re-arm with the next dispatch.

### Watching a PR from any Pane

```bash
runpane pr watch --pane <pane-id> --url https://github.com/owner/repo/pull/123 --head <full-sha> --json
runpane watch --pane <pane-id> --since <generation-returned-above> --epoch <epoch-returned-above> --until-event --json --kinds pr.checks,pr.conflicted,pr.base_changed,pr.base_deleted,pr.head,pr.review,pr.comment,pr.closed,pr.merged,pr.stopped,github.unavailable,github.recovered
runpane pr list --pane <pane-id> --json
runpane pr unwatch --pane <pane-id> --url https://github.com/owner/repo/pull/123 --json
```

Inside a Pane, registration defaults to its `PANE_SESSION_ID`. Registration
returns `generation` and `epoch`; use both for the first wait, including events
that arrived between registration and arming. An identical active registration
retry returns its original generation, including after daemon restart, so a
lost response cannot skip an unread event. A new head pin or unwatch/re-register
starts a new registration. Process every returned NDJSON
event, then persist its `gen` and `epoch`. Rearm with `--since <gen> --epoch
<epoch>`; use `--limit 1` for one event per invocation. Never reuse the initial
registration generation after delivering an event, and never combine `--as`
with `--since` or `--epoch`. A named cursor is a separate daemon-managed mode.

Ordinary daemon restarts preserve the epoch and unread retained events. On
`_reset` or `_dropped`, resynchronize current GitHub state before accepting
success, then persist the control record's `generation` and `epoch`. Ignore
`replay`/`baseline` records as new events. Retention is bounded; a journal reset
cannot recover lost history. A consumer crash before saving its cursor can
replay an event, so actions must be idempotent. Registration uses the full
host/repository/number identity. It pins success to `--head`, or the first
observed head; a new head emits `pr.head` and needs a fresh registration before
success can be reported. Read existing discussions before arming. A wake
means inspect the change; it never authorizes merging.

The watch also reports when the ground under the PR moves. `pr.base_changed`
(`BASE CHANGED`) fires when the base branch is retargeted, by a person or by
GitHub after a stack parent merges and its branch is deleted; `base.from` and
`base.to` name the old and new base. `pr.base_deleted` (`BASE DELETED`) fires
when the base branch no longer exists; GitHub may close the PR right after.
Both arrive at once under `--follow`. Rebase onto the new base and recheck CI.

The daemon batches up to 25 fingerprints per host every two minutes (plus up
to ten seconds of jitter), reads details on changes and at a 30-minute
backstop, and keeps 10% of GitHub quota for interactive work. It uses `gh auth
token` for cached authentication and direct GraphQL for reads. Session PR
branch discovery still uses Pane's existing `gh pr list` lookup.

Failures emit immediately, even while other checks run. Success requires a
complete, nonempty set of checks on the pinned head and all required checks
passing (all checks when none are marked required). BLOCKED/UNKNOWN merge
status conservatively withholds success, including when reviews are missing.
Feedback from every account is included: agents and people can share a login.
Checks passing is a signal to inspect the PR, not proof of complete readiness;
optional failures can still produce a separate failure event. Merge/close,
eight non-rate-limit failures, or ten comment-only updates stop registration;
archiving/deleting the Pane removes it. Rate limits pause instead of consuming
the failure budget. Outages and recovery are journal events.

Fingerprints include individual check outcomes and thread resolution state, so
equal aggregate counts do not hide swaps or edits. When the fingerprint window
is truncated (over 100 checks/discussion items or multiple comments in a review
thread), the daemon reads details each round. Detail reads page through up to
2,000 checks and retain the latest 100 comments, reviews, threads, and comments
per thread. Truncated discussions emit `pr.review` with an incomplete-feedback
reason and withhold success; read the full discussion on GitHub.

Baselines and events are replaced atomically before readers wake. This prevents
a process crash from advancing a baseline without its event. Delivery remains
bounded by journal retention and cursor acknowledgments; replay after a consumer
crash before acknowledgment is possible. This is not an exactly-once or
power-loss durability guarantee.

Removed flags fail with replacement guidance: `--settle` became
`--ready-settle`; `--format` became `--json`; all-managed/agents-only,
quiet/no-control-lines, and idle-backoff are covered by defaults or profiles.

## Attribution

PyPI package downloads use `source=pip` when requesting release artifacts from
`runpane.com/api/download`. If that route is unavailable, the CLI falls back to
matching GitHub release assets and prints a warning.

The wrapper sends best-effort command failures and download lifecycle telemetry
with a persisted anonymous `install_id`. Successful routine commands emit nothing.
Distinct `install_id` counts on `runpane_wrapper_*` events measure installs that
report failures or download activity, not all CLI users. Telemetry is disabled in
CI, when local analytics is explicitly opted out, or with `RUNPANE_TELEMETRY_DISABLED=1`.

## Maintenance Notes

Keep the npm and PyPI clients in sync with each Pane release. When changing
shared installer behavior:

- If release asset names or platforms change, update both npm and PyPI wrapper
  artifact matching.
- If `runpane` CLI behavior changes, update both clients and the shared smoke
  tests.
- If the website `/api/download` contract changes, verify npm and PyPI fallback
  behavior.
- If daemon setup flags change, update docs, README files, and wrapper tests
  together.
- Keep the CI wrapper matrix green: Linux, macOS, Windows, Node 20/22, and
  Python 3.8/3.13 (runs on PRs that touch the wrappers or contract).

## Publishing

This package should be published through PyPI Trusted Publishing from GitHub
Actions. Token-based `PYPI_API_TOKEN` publishing is a fallback for first package
reservation or manual publication only.
