# Pane: agent guide

Electron desktop app for running coding agents in parallel git worktrees.
Canonical repo: `greenfield-inc/Pane` (`dcouple/Pane` redirects to it).

## Map

- `main/` Electron main process · `frontend/` React + Vite renderer ·
  `shared/` types · `tests/` Playwright · `packages/runpane{,-py}` the CLI ·
  `mobile/` Capacitor companion
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, tests, debugging, PRs
- [RUNBOOK.md](RUNBOOK.md): releases, CI, preview deploy, secrets, migrations

## Commands

- Node >= 22.18 (`.nvmrc`), pnpm 10. Setup `pnpm run setup`; run
  `PANE_DIR=~/.pane_test pnpm dev` (not `electron-dev`: its watcher overwrites
  the bundled preload). Build the local CLI with `pnpm --filter runpane build`.
- Before a PR: `pnpm typecheck && pnpm lint`, plus the tests your change touches.
- Tests: `pnpm --filter frontend test`. Main: `npm rebuild
  better-sqlite3-multiple-ciphers` first (setup builds it for Electron), then
  `pnpm --filter main exec vitest run` (plain `pnpm --filter main test` is watch
  mode); run `pnpm electron:rebuild` before starting the app again.
  Playwright: install the browser once with `pnpm exec playwright install
  chromium`; `pnpm test:ci:minimal` launches the app, so set `PANE_DIR`.

## Rules

- Never point a dev build, test run or script at your real `~/.pane`: set
  `PANE_DIR`. It does not isolate Electron's browser profile; see
  [Running a dev build safely](CONTRIBUTING.md#running-a-dev-build-safely).
- Never release, publish, deploy or migrate real data unless asked.
- No explicit `any`; blocking lint is the floor, with no broad suppressions
  ([docs/lint/anti-slop.md](docs/lint/anti-slop.md)).
- Dependencies changed: run `pnpm run generate-notices` and commit `NOTICES`.
- Don't change build targets without discussion.
- `runpane` CLI defaults stay responsive. Anything that makes output quieter or
  slower for the Pane Chat orchestrator (e.g. `watch --settle`, `--min-interval`)
  is an opt-in flag; the orchestrator's values live in the "Liveness Contract"
  text in `main/src/services/skillCacheManager.ts`.
- The full terminal refresh on panel activation is load-bearing: read the
  comment above `TerminalPanel` (`frontend/src/components/panels/TerminalPanel.tsx`)
  first, and keep refits hidden behind its loading overlay (`isRefreshing`).
- UI: theme tokens only; swapping indicators share a fixed-size box; animations
  on one surface share a period.
- Commits: present tense, focused, reference issues.

## Docs

When a change makes any doc wrong (README.md, AGENTS.md, RUNBOOK.md,
CONTRIBUTING.md, docs/), update or delete that doc in the same PR. A doc that
describes code which no longer exists is deleted, not annotated. Plans, briefs
and debug handoffs don't live in the repo: put them in the PR description or
the tracker.

The block below, between the `pane-agent-context` markers, is written by Pane
itself for any repo it manages (`main/src/services/agentContextManager.ts`). It
tells agents how to *use* Pane. To change it, change that code; don't edit it by
hand here.

<!-- pane-agent-context:start -->
## Pane

This repository is used with [Pane](https://runpane.com). Drive it with the CLI or the `pane` MCP server.

CLI: `npm i -g runpane` (or `npx --yes runpane@latest`), then `runpane doctor --json`. Full command reference: `runpane agent-context --json`.

MCP: packaged Pane registers a stdio server named `pane` with Claude Code, Codex, and Cursor. Check the connection with `claude mcp list`, `codex mcp list`, or `agent mcp list`. Cursor may ask you to enable `pane` with `agent mcp enable pane`. If tools are missing, add it in the agent's MCP settings: Claude Code `claude mcp add --scope user pane -- npx --yes runpane@latest mcp`; Codex (`~/.codex/config.toml`) table `[mcp_servers.pane]` with `command = "npx"` and `args = ["--yes", "runpane@latest", "mcp"]`; Cursor (`~/.cursor/mcp.json`) uses `mcpServers.pane` with the same `npx` command and args; any other stdio client uses them too.

Computer use: where the user turned it on for a machine, the `pane` MCP server's `js` tool sees and operates desktop apps in the background, for example to QA a desktop app. Load the `pane-computer-use` skill before using it; docs: `runpane docs read --doc docs/COMPUTER_USE.md`.
<!-- pane-agent-context:end -->
