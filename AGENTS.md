# Pane: agent guide

Electron desktop app for running coding agents in parallel git worktrees.
Canonical repo: `greenfield-inc/Pane` (`dcouple/Pane` redirects to it).

## Map

- `main/` Electron main process · `frontend/` React + Vite renderer ·
  `shared/` types · `tests/` Playwright · `packages/runpane{,-py}` the CLI ·
  `packages/pane-cloud-contract` the Pane Cloud service and fleet APIs ·
  `mobile/` Capacitor companion
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the pieces fit
- [CONTRIBUTING.md](CONTRIBUTING.md): setup, tests, debugging, PRs
- [RUNBOOK.md](RUNBOOK.md): releases, CI, preview deploy, secrets, migrations

## Commands

- Node 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+ (26.x); `.nvmrc` pins 22.23.4. Use pnpm 10. Setup `pnpm run setup`; run
  `PANE_DIR=~/.pane_test pnpm dev` (not `electron-dev`: its watcher overwrites
  the bundled preload). Build the local CLI with `pnpm --filter runpane build`.
- Before a push: `pnpm check:fast` (type check, lint, offline links when
  lychee is installed, renderer test types, and the unit tests your changes
  reach), plus any other tests your change touches.
  Agent facts (ids, executables, modes, versions, env var names) live in
  `contracts/runpane/contract.json` `agents`; read them through
  `shared/agents.ts`, never as literals. `pnpm lint` (and CI) fails on one;
  `scripts/agent-names-allowlist.json` caps the files still exempt.
- Tests: `pnpm --filter frontend test`. Main: `npm rebuild
  better-sqlite3-multiple-ciphers` first (setup builds it for Electron), then
  `pnpm --filter main exec vitest run` (plain `pnpm --filter main test` is watch
  mode); run `pnpm electron:rebuild` before starting the app again.
  Playwright: install the browser once with `pnpm exec playwright install
  chromium`; `pnpm test:ci:minimal` serves the renderer from Vite alone, while
  `pnpm test` also launches the app, so set `PANE_DIR`.

## Rules

- Never point a dev build, test run or script at your real `~/.pane`: set
  `PANE_DIR`. Without one a dev build uses `~/.pane_dev`, which may hold old
  data. `PANE_DIR` does not isolate Electron's browser profile; see
  [Running a dev build safely](CONTRIBUTING.md#running-a-dev-build-safely).
- Never release, publish, deploy or migrate real data unless asked.
- No explicit `any`; blocking lint is the floor, with no broad suppressions
  ([docs/lint/anti-slop.md](docs/lint/anti-slop.md)).
- Dependencies changed: run `pnpm run generate-notices` and commit `NOTICES`.
- Don't change build targets without discussion.
- `runpane watch --follow` has one default cadence (READY 3m, BLOCKED 30s,
  batch 10m, IDLE after 10m with backoff, 3h quiet expiry, heartbeats off).
  Explicit duration flags override it; `--until-event` delivers immediately
  without follow settling or batching. Cadence requires a named follow consumer;
  `--follow --since <generation>` also bypasses it. Keep npm/Python,
  contract/doctor docs, and the Liveness Contract in `skillCacheManager.ts` aligned.
- The full terminal refresh on panel activation is load-bearing: read the
  comment above `TerminalPanel` (`frontend/src/components/panels/TerminalPanel.tsx`)
  first, and keep refits hidden behind its loading overlay (`isRefreshing`).
- UI: theme tokens only; swapping indicators share a fixed-size box; animations
  on one surface share a period.
- Errors say what happened, why, what changed, and the next step: throw
  `PaneError` (main) or `RunpaneError` (CLI) with a `code` and `next`. See
  [How Pane reports errors](CONTRIBUTING.md#how-pane-reports-errors).
- Commits: present tense, focused, reference issues.
- Merge on `CI result` only; stacks merge bottom-up with merge commits and no
  rebase, and only when the person asks: see [Merging](CONTRIBUTING.md#merging).

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

1 feature = 1 worktree = 1 branch = 1 Pane; reviews, audits, fixes and QA for it are tabs in that Pane. Open later agents with `runpane panels create --pane <id>` (MCP: `panels_create` or `agents_start` with `pane`), not a new Pane.

When you need the person (a choice, an approval, a short answer), call the `notify` MCP tool (or `runpane notify`) instead of asking in the terminal. If it returns `waiting`, call it again with `resume`; if it returns `unavailable`, ask in the terminal. Claude's own card (AskUserQuestion) is only for a quick question in the chat the person is typing in, about their latest message, that steers only this turn; everything else is an approval card, and Codex and other agents always use one. A worker in a Pane Session (`PANE_SESSION_DIR` set, `PANE_ORCHESTRATION_SESSION_ID` unset) doesn't call `notify`: it reports blocked to its orchestrator with `runpane report --state blocked --question "<question>"`. Its orchestrator relays that card with `runpane notify --relays <item> ...`, the answer goes straight to the worker's tab, and the orchestrator records it with `runpane inbox ack <item> --decision <D-n>`. For an API key, token or password, call `secrets_request` (or `runpane secrets request`), never `ask`; if that returns `unavailable`, ask the person to save it in Pane under Settings > Secrets.

CLI: `npm i -g runpane` (or `npx --yes runpane@latest`), then `runpane doctor --json`. Full command reference: `runpane agent-context --json`.

MCP: packaged Pane registers a stdio server named `pane` with Claude Code, Codex, and Cursor. Check the connection with `claude mcp list`, `codex mcp list`, or `agent mcp list`. Cursor may ask you to enable `pane` with `agent mcp enable pane`. If tools are missing, add it in the agent's MCP settings: Claude Code `claude mcp add --scope user pane -- npx --yes runpane@latest mcp`; Codex (`~/.codex/config.toml`) table `[mcp_servers.pane]` with `command = "npx"` and `args = ["--yes", "runpane@latest", "mcp"]`; Cursor (`~/.cursor/mcp.json`) uses `mcpServers.pane` with the same `npx` command and args; any other stdio client uses them too.
<!-- pane-agent-context:end -->
