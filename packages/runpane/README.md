# runpane

Install or configure Pane from npm.

The package does not include the Pane desktop runtime. It downloads the correct
Pane release artifact only when you run `runpane install` or `runpane update`.

The same CLI also drives a running Pane app: list and add repos, create and
manage panes, read and send input to panels, manage sessions, and follow events
with `runpane watch`. See the
[runpane CLI contract](https://github.com/greenfield-inc/Pane/blob/main/docs/RUNPANE_CLI_CONTRACT.md) for every command.

## Quick Start

Run the guided setup (Node 20 or newer):

```bash
npx --yes runpane@latest
```

Persistent install:

```bash
npm i -g runpane
runpane setup
```

Use the arrow keys and Enter to choose an action; Esc or Ctrl+C cancels.

The wizard can install Pane on this machine, configure this machine as a remote
host, update Pane, or run diagnostics. For remote access, choose **Set up a remote
host**, accept or enter a name, and follow the Tailscale login
prompts. Copy the connection code into Pane on your other device or
[runpane.com/app](https://runpane.com/app/). Sign that device into the same
Tailscale network first. No tunnel flags are needed in the wizard.

## MCP Server

`runpane mcp` runs a stdio MCP server whose tools mirror the `runpane`
commands, generated from the CLI contract. The Pane desktop app registers it
with Claude Code, Codex, and Cursor automatically. To register it yourself:

```bash
claude mcp add --scope user pane -- npx --yes runpane@latest mcp
codex mcp add pane -- npx --yes runpane@latest mcp
```

See [docs/PANE_MCP.md](https://github.com/greenfield-inc/Pane/blob/main/docs/PANE_MCP.md).

## Developing This Repository

When debugging RunPane from a Pane repository checkout, prefer the built local
wrapper over `npx --yes runpane@latest` so diagnostics exercise local changes.
Use Node 22 or newer:

```bash
node packages/runpane/dist/cli.js doctor --json
```

`doctor` remains the first diagnostic command before local-control actions. On
macOS it reads installed app bundle metadata and must not launch
`Pane.app/Contents/MacOS/Pane --version`.

## Advanced

### Explicit Commands

```bash
npx --yes runpane@latest setup
npx --yes runpane@latest install client
npx --yes runpane@latest install daemon --label "My Server"
npx --yes runpane@latest update --pane-only
npx --yes runpane@latest doctor
```

`runpane install daemon` installs Pane and then invokes the installed executable
with `--remote-setup`, preserving the `pane-remote://...` connection-code output.

### Package Managers

One-shot execution:

```bash
pnpm dlx runpane@latest
yarn dlx runpane@latest
bunx runpane@latest
```

Persistent install:

```bash
npm i -g runpane
runpane setup

pnpm add -g runpane
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

Work an agent sends with `panels create`, `panes create` (with a prompt), or
`panels submit` expects that report; `--no-expect-report` sends without
waiting, and `--expect-report` asks for one on `--source user` work. If the
agent goes ready, with nothing left running in the background, or exits
without one,
watchers that list `agent.report.missing` get `MISSING REPORT <pane> pane
<pane-id> panel <panel-id> ready` with its last reply; add it to `--kinds`, for
example `--until-event --kinds
agent.report,agent.report.missing,agent.blocked,panel.exited,pane.gone`.
`runpane inbox [--session <id|name>]` lists the reports, missing reports, and
on-screen questions a Session has not acknowledged (an orchestrator reads it
when it starts or resumes), and `runpane inbox ack <id>...` clears them.

To dispatch and get the result in one call, add `--wait`. It blocks on that
panel and prints one line of JSON when the worker reports (exit 0), ends
without a report (3, with `lastOutput`), waits on a prompt (4, with
`screenLines`), or exits (5); `--timeout 30m` gives up with exit 124. Run it as
a background task:

```bash
runpane panels submit --panel <panel-id> --input-file prompt.md --as-file-pointer --wait --yes
```

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

### Handing Work to Another Machine

`runpane handoff` passes a task to another agent on this or another of your
machines. Write the note from the template, then name the agent and machine in
plain words. The CLI checks every section is filled in, needs the branch pushed
(`--push` commits uncommitted work as WIP and pushes, never forcing), and starts
the agent in a new Pane there, branched from yours. It reports back to you.

When you run it from a Pane tab with a Claude, Codex, Cursor or OpenCode session and the
receiver is the same agent, it carries that session. Another machine gets a copy
of the session's files in its agent store and resumes the same id; this machine
resumes a fork, so two agents never share one session. The CLI checks the
receiver resumed it and shows its last message, then reports `continuity.result`:
`continued`, `inconclusive` (exit 0; `next` gives a question to ask the
receiver), or `not-continued` (exit 1; the receiver is kept and `next` gives the
`--note-only` command). After `continued` or `inconclusive`, stop working on the
branch; the session continues there. `--note-only`, a different agent, or no
session to carry starts a fresh agent with the note, and the output says so.
OpenCode keeps sessions in a database, so its session travels as `opencode export`
and is brought in with `opencode import` inside the receiving repository; an
OpenCode receiver is accepted only to continue an OpenCode session. Carrying a
Cursor chat to another machine is best effort, since Cursor's store is
undocumented; on the same machine it isn't carried (`not-continued`), because a
copied Cursor chat still writes to the original. The destination's agent store
is assumed at its default location (`~/.claude`, `~/.codex`, `~/.cursor`). A
copy already there is replaced only when yours holds all of it and no agent
there runs it; otherwise nothing is copied and the result is `not-continued`.
A destination Pane too old to resume a carried session
(`ERR_HANDOFF_RESUME_UNSUPPORTED`) is refused before anything is sent.

```bash
runpane handoff --template > ~/handoff.md
runpane handoff "claude opus on parsas-macbook-pro" --note-file ~/handoff.md --push
```

From a Session's terminal (its folder is outside git), handoff moves the Session:
it skips git, writes the note to the other machine, and creates a Session there
with the same name (numbered if taken), goal and agent, whose next action is to
read the note. With the same agent it also copies your agent session, and the new
Session resumes it when first opened (`continuity.result` is `inconclusive` until
then). It refuses this machine before sending, and `--json` reports
`receiver.route: "session"` and the new `session`.

`--dry-run` checks destination daemon reachability and resolves its saved repository
(name, path, environment and OS) without committing, pushing, fetching, writing a
note or creating a Pane. These checks also run before `--push` changes sender work.

From WSL, when no local Linux daemon exists, handoff can use the Windows host's
Pane through its enabled workspaces connection (Windows Tailscale and Pane
workspaces must be reachable). Repository listing and Pane creation use the
reached daemon directly, so the host needs no global CLI installation. Select a Windows-native saved
repository with `--repo`. Saved WSL repositories are rejected before sending.
An explicit `--pane-dir` or `PANE_DIR` keeps that instance selected instead of
falling back to a different host instance.

Success requires verified prompt delivery (`taken` or `queued`). If a startup
dialog blocks delivery or evidence is missing, handoff exits nonzero and includes
the created Pane, panel ID and a `runpane panels screen` inspection command.
Inspect that receiver before retrying to avoid creating a duplicate Pane.

`runpane handoff --help` lists every option. Model selection works for Claude, Codex and Cursor. Effort selection works for Claude and Codex; Cursor effort is rejected before committing or sending.

## Attribution

npm package downloads use `source=npm` when requesting release artifacts from
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

This package should be published through npm Trusted Publishing from GitHub
Actions. Token-based `NPM_TOKEN` publishing is a fallback for first package
reservation or manual publication only.
