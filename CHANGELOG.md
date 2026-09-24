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
- Cursor Agent CLI (`cursor-agent`) as a third built-in agent tool: launch pill/menu entries with `mod+alt+5`, prompt-as-argument delivery, chat pre-creation with resume-after-restart, at-a-glance status detection, RunPane `--agent cursor` support with a doctor fallback probe for `~/.local/bin`, and a Cursor option for the Pane Chat orchestrator. Pane supports Cursor in macOS, Linux, and WSL repositories. Native Windows launches stay disabled.

### Changed
- Custom-command keyboard shortcuts moved from `mod+alt+5..9` to `mod+alt+6..9` to make room for the Cursor slot.
- Cursor Agent is now available inside WSL repositories.
- Repository main panes now show the default shell in the bottom dock. The dock defaults to expanded in both main and worktree panes, while preserving saved collapse preferences.
- `runpane watch` defaults are unchanged and stay responsive: no settle, no batching, all event kinds, IDLE every 10 minutes, HEARTBEAT every 60 seconds under `--follow`.
- The Pane Chat orchestrator's Liveness Contract now arms the cadence flags above, filters HEARTBEAT out of its monitor, and judges a dead watch by a non-zero exit or a `WATCH ERROR` line rather than by silence.

### Fixed
- Agent terminals remain in working tabs after deleting the default shell and switching panes. Closing the dock also repairs tab selection when another shell takes its place.
- Pane Chat has its skills again. Pane synced its agents' skills from the skills repository, which moved them on 2026-08-13; every sync since then failed, and new installs had none. Pane now ships 37 skills: Agent Farm's current raw-profile skills and their helpers, general-purpose primitives such as `verify-app`, `options`, `brief`, and `orchestrate-sessions`, and three Pane-specific ones (`pane-orchestrator`, `runpane`, `pane-work`). It also installs four helper subagents (explorer, cold-reader, qa-and-verify, reviewer) for Claude and Codex Sessions. The skill sync is removed, and Pane deletes its old sync folders.
- `runpane panels submit` now submits prompts to Claude panes instead of leaving them in the composer. Pane waits for Claude's composer, types the prompt, and presses Enter separately once the text shows, so a pane created with `--wait-ready` and submitted to right away starts the turn. `verifiedSubmitted` is true only when Claude's composer is seen empty afterwards.
- `runpane panels screen` reports `composer.hasUndeliveredText` for Claude panes. It used to read false for every Claude pane, even with a prompt sitting in the composer. Claude's dim placeholder suggestion does not count.
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
