# Changelog

All notable changes to Pane will be documented in this file.

## [Unreleased]

### Added
- Opt-in cadence flags for `runpane watch --follow`, so an orchestrator that pays for every line can wake up less often without changing what everyone else sees. `--settle <ms>` emits READY only after a pane stays idle that long (a BUSY inside the window cancels it silently, which removes the idle/working flips a pane makes while it waits on subagents). `--blocked-settle <ms>` does the same for BLOCKED. `--min-interval <ms>` holds non-urgent lines and flushes them together at most once per interval; BLOCKED bypasses it. `--idle-backoff` fires IDLE at `--idle-after`, then 30m, 1h, 3h, then daily, and resets on activity. Use `--kinds` to drop `agent.busy`, which carries no action. The flags require `--follow`. Recommended orchestrator invocation, budgeted at about 6 wake-ups per active pane per hour worst case, usually 1 to 3:

  ```bash
  runpane watch --self-test
  runpane watch --follow --kinds agent.ready,agent.blocked,agent.idle,panel.exited,pane.gone --settle 180000 --blocked-settle 30000 --min-interval 600000 --idle-backoff
  ```

  Pane Chat arms this automatically through its pane-orchestrator skill, so you only need the flags for your own scripts. `runpane watch --help`, `runpane agent-context --command watch --json`, and `runpane doctor` (which now prints the effective watch defaults) document every flag with its default.
- `runpane watch --quiet` (alias `--no-control-lines`) drops the control lines that only prove liveness (`WATCH OK`, `HEARTBEAT`, `WATCH RECONNECTED`; `_ok`, `_heartbeat`, `_reconnected` in JSON). `WATCH ERROR`, `RESET`, and `DROPPED` always print. Under `--follow`, JSON entries now carry `heldInputPresent: true`, the JSON form of `STUCK`.
- `runpane watch --session <id|name>` follows every Pane associated with a named Session. The daemon re-reads the Session's Panes on every read, so `sessions associate` and `sessions detach` take effect without re-arming the watcher, detached and archived Panes drop out, and the Session's own orchestrator panel is never reported. New journal kinds `pane.associated` and `pane.detached` (`JOINED` and `LEFT` lines) record membership changes; other watchers get them only when `--kinds` lists them. The cursor defaults to `session-<uuid>`, and cadence state is keyed by the Session, so held lines survive membership changes. `--session` cannot be combined with `--pane`, an unknown Session fails, and a daemon too old for `--session` fails the watch instead of watching every Pane.
- Session watchers hear about PRs: for Panes associated with a live Session, the daemon finds each member's PR by branch (even for a worker nobody is looking at) and polls open ones with `gh pr view` about every 3 minutes (never when no Session has a member) and appends `pr.conflicted` (`PR <pane> #747 CONFLICTED`), `pr.checks` (`CHECKS PASSED`, or `CHECKS FAILED lint,test`), and `pr.merged` (`MERGED`) on transitions only. A conflict and failed checks bypass `--min-interval` like BLOCKED. The kinds reach `runpane watch --session` and any watch whose `--kinds` lists them, and the orchestrator skill's Session watcher now lists them. A missing, signed-out, or rate-limited `gh` backs off quietly.
- `runpane watch --json` marks the baseline entries it replays after a reset with `replay: true`. A replayed `agent.ready` restates current state and is never READY.
- A "user present" watch profile (`--settle 60000 --blocked-settle 15000 --min-interval 120000`, no `--idle-backoff`) documented next to the unattended one, for when someone is waiting on the result: READY arrives within about 3 minutes instead of 13.
- `runpane panes archive` explains a skipped safety check: `safetyCheck.reason` is `external-worktree`, `main-repo`, `missing-project-context`, or `git-error`, and `worktreeWillRemain: true` marks an archive that leaves the worktree on disk.
- Workers hand back a structured report: `runpane report --state ready|blocked|failed|done [--pr <n>] [--head <sha>] [--summary <text>|--summary-file <path|->] [--question <text>]`. Inside a Pane terminal it reports for its own panel (`PANE_SESSION_ID`, `PANE_PANEL_ID`); elsewhere pass `--pane` and `--panel`. `--question` is required when blocked. Pane keeps the latest report on the panel (up to 16,000 characters of summary, surviving restarts), journals an `agent.report` watch event (`REPORT fix-login pane <id> panel <id> ready pr#747 fc5dce9`) that skips the `--min-interval` batch, records it as Session activity, and shows it in `agents status`, `panels list`, and `sessions overview` (`panes[].report`). Only watchers that list `agent.report` in `--kinds` receive it, so older CLIs are unaffected. The orchestrator skills now end worker prompts with a `runpane report` line and treat the report as the completion signal.
- `runpane panels last-message --panel <id>` reads a Claude or Codex agent's last reply from its transcript (bounded by `--limit`, default 20,000 characters). It never scrapes the screen: without a transcript it returns `transcript-unavailable` and exits 1.
- Cursor Agent CLI (`cursor-agent`) as a third built-in agent tool: launch pill/menu entries with `mod+alt+5`, prompt-as-argument delivery, chat pre-creation with resume-after-restart, at-a-glance status detection, RunPane `--agent cursor` support with a doctor fallback probe for `~/.local/bin`, and a Cursor option for the Pane Chat orchestrator. Pane supports Cursor in macOS, Linux, and WSL repositories. Native Windows launches stay disabled.

### Changed
- Custom-command keyboard shortcuts moved from `mod+alt+5..9` to `mod+alt+6..9` to make room for the Cursor slot.
- Cursor Agent is now available inside WSL repositories.
- `runpane watch` defaults are unchanged and stay responsive: no settle, no batching, all event kinds, IDLE every 10 minutes, HEARTBEAT every 60 seconds under `--follow`.
- The Pane Chat orchestrator's Liveness Contract now arms the cadence flags above, filters HEARTBEAT out of its monitor, and judges a dead watch by a non-zero exit or a `WATCH ERROR` line rather than by silence.
- The Pane Chat orchestrator arms one `runpane watch --session` watcher for its whole Session instead of one `--pane` per Pane with a re-arm after every associate or detach, and treats a `replay: true` entry as state to re-read rather than READY.
- The Pane Chat orchestrator arms its Session watcher with `--quiet` and the cursor `session-<uuid>`, documents both watch profiles, dispatches long prompts as a one-line pointer to a prompt file, and tells workers to wait for shared resources instead of taking them over.
- `runpane agent-context --command <unknown>` exits 2 with the closest command names. With `--json` it prints `{ ok: false, code: "unknown_command", message, candidates }` on stdout instead of plain text on stderr.
- `runpane panes create` shows `--base-branch` in its usage line, and daemon command usage lines show `[--pane-dir <path>]`.

### Fixed
- Pane Chat has its skills again. Pane synced its agents' skills from the skills repository, which moved them on 2026-08-13; every sync since then failed, and new installs had none. Pane now ships 37 skills: Agent Farm's current raw-profile skills and their helpers, general-purpose primitives such as `verify-app`, `options`, `brief`, and `orchestrate-sessions`, and three Pane-specific ones (`pane-orchestrator`, `runpane`, `pane-work`). It also installs four helper subagents (explorer, cold-reader, qa-and-verify, reviewer) for Claude and Codex Sessions. The skill sync is removed, and Pane deletes its old sync folders.
- `runpane panels submit` now submits prompts to Claude panes instead of leaving them in the composer. Pane waits for Claude's composer, types the prompt, and presses Enter separately once the text shows, so a pane created with `--wait-ready` and submitted to right away starts the turn. `verifiedSubmitted` is true only when Claude's composer is seen empty afterwards.
- `runpane panels screen` reports `composer.hasUndeliveredText` for Claude panes. It used to read false for every Claude pane, even with a prompt sitting in the composer. Claude's dim placeholder suggestion does not count.
- `runpane watch` named cursors may be up to 128 characters, so `session-<full session id>` works. The CLI shortens a derived cursor name longer than 64 characters (the `PANE_PANEL_ID` default in orchestrator panels) to `panel-<sha256 prefix>`, which older daemons accept.
- `runpane agent-context` and `runpane version` accept and ignore `--pane-dir`, so one `--pane-dir` works for every command.
- `runpane watch` no longer reports STUCK for the grey prompt suggestion Claude Code shows in an empty composer. STUCK now means real unsubmitted composer text.

## [1.1.123] - 2026-04-25

### Added
- Explorer right-click actions for file creation, rename, copy, cut, paste, duplicate, path copy, reveal, and delete.
- Inline Explorer rename plus keyboard shortcuts for rename, delete, copy, cut, and paste.
- Drag-and-drop file moves and target-aware external file drops into Explorer folders.

### Changed
- Explorer delete now prefers the OS trash/recycle bin with a permanent-delete fallback.
- Browser tab and Explorer global shortcuts no longer intercept text editing shortcuts while inputs are focused.

## [0.0.1] - 2026-02-19

### Initial Release
- Terminal-first AI code assistant manager
- Multi-session support with Claude Code and Codex
- Git worktree integration for isolated development
- Real-time terminal output with XTerm.js
- Project and session management
- Rich output view with syntax highlighting
