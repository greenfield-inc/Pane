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
npx --yes runpane@latest update
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

### Common Options

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
plus `HEARTBEAT` every 60 seconds as proof of life.

```bash
runpane watch --self-test
runpane watch --follow
```

The defaults are responsive: no settle, no batching, all event kinds, `IDLE`
every 10 minutes. Panes and shell users see every event immediately.

A consumer that pays for every line (an orchestrator that re-reads its whole
context per wake-up) opts into cadence shaping instead. This is the recommended
orchestrator invocation, budgeted at about 6 wake-ups per active pane per hour
worst case, usually 1 to 3:

```bash
runpane watch --self-test
runpane watch --follow --quiet --kinds agent.ready,agent.blocked,agent.idle,panel.exited,pane.gone --settle 180000 --blocked-settle 30000 --min-interval 600000 --idle-backoff
```

When someone is waiting on the result, use the user-present profile instead:
`--settle 60000 --blocked-settle 15000 --min-interval 120000` with no
`--idle-backoff`, so `READY` arrives within about 3 minutes rather than 13.

A Session orchestrator watches its whole Session with one command instead of
one `--pane` per Pane. The daemon re-reads the Session's Panes on every read,
so `sessions associate` and `sessions detach` need no re-arm, and `JOINED` and
`LEFT` (`pane.associated`, `pane.detached`) report the change. For Session
members with an open PR, the daemon also polls GitHub about every 3 minutes
and reports `PR <pane-name> pane <pane-id> #<number> CONFLICTED`, `CHECKS
PASSED` or `CHECKS FAILED <names>`, and `MERGED` (`pr.conflicted`,
`pr.checks`, `pr.merged`) on transitions only. The cursor defaults to
`session-<uuid>`:

```bash
runpane watch --session <session-id> --follow --quiet --json --kinds agent.ready,agent.blocked,agent.idle,panel.exited,pane.gone,pane.associated,pane.detached,pr.conflicted,pr.checks,pr.merged --settle 180000 --blocked-settle 30000 --min-interval 600000 --idle-backoff
```

After a `RESET`, JSON baseline entries carry `replay: true`. They restate
current state, so a replayed `agent.ready` is never `READY`.

- `--kinds` drops `agent.busy`; `BUSY` carries no action.
- `--settle <ms>` emits `READY` only after the panel stays idle that long. A
  `BUSY` inside the window cancels it silently, which removes the idle/working
  flips a pane makes while it waits on subagents.
- `--blocked-settle <ms>` does the same for `BLOCKED`, so a prompt answered in
  the pane within seconds wakes nobody.
- `--min-interval <ms>` holds non-urgent lines and flushes them together at
  most once per interval. `BLOCKED` bypasses it.
- `--idle-backoff` fires `IDLE` at `--idle-after`, then 30m, 1h, 3h, then
  daily, and resets on any activity.

These flags require `--follow`. Pane Chat arms them automatically through its
pane-orchestrator skill, so you only need them for your own scripts. Pass
`--quiet` to any monitor that wakes an agent: it drops `WATCH OK`, `HEARTBEAT`,
and `WATCH RECONNECTED` (`_ok`, `_heartbeat`, `_reconnected` in JSON), while
`WATCH ERROR`, `RESET`, and `DROPPED` always print. Judge a dead watch by a
non-zero exit or a `WATCH ERROR` line, not by silence. `runpane agent-context
--command watch --json` lists every flag with its default.

Workers can hand back a structured report with `runpane report --state
ready|blocked|failed|done [--pr <n>] [--head <sha>] [--summary-file <path>]
[--question <text>]`. Watchers receive it as `agent.report`
(`REPORT <pane> pane <pane-id> panel <panel-id> ready pr#747 fc5dce9`) only
when `--kinds` lists it, and it skips the `--min-interval` batch.
`runpane panels last-message --panel <panel-id>` reads an agent's last reply
from its transcript.

### Handing Work to Another Machine

`runpane handoff` passes a task to a fresh agent on this or another of your
machines. Write the note from the template, then name the agent and machine in
plain words. The CLI checks every section is filled in, needs the branch pushed
(`--push` commits uncommitted work as WIP and pushes, never forcing), and starts
the agent in a new Pane there, branched from yours. It reports back to you.

```bash
runpane handoff --template > ~/handoff.md
runpane handoff "claude opus on parsas-macbook-pro" --note-file ~/handoff.md --push
```

`runpane handoff --help` lists every option.

## Attribution

npm package downloads use `source=npm` when requesting release artifacts from
`runpane.com/api/download`. If that route is unavailable, the CLI falls back to
matching GitHub release assets and prints a warning.

The wrapper also sends best-effort lifecycle telemetry with a persisted
anonymous `install_id`. Count distinct wrapper users with
`count(DISTINCT properties.install_id)` on `runpane_wrapper_*` events. Set
`RUNPANE_TELEMETRY_DISABLED=1` to disable wrapper telemetry.

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
