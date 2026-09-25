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
  `PANE_DIR=~/.pane_test pnpm dev` (never `electron-dev`: it skips the preload
  bundle). Build the local CLI with `pnpm --filter runpane build`.
- Before a PR: `pnpm typecheck && pnpm lint`, plus the tests your change touches.
- Tests: `pnpm --filter frontend test`. Main: `npm rebuild
  better-sqlite3-multiple-ciphers` first (setup builds it for Electron), then
  `pnpm --filter main exec vitest run` (plain `pnpm --filter main test` is watch
  mode); run `pnpm electron:rebuild` before starting the app again.
  `pnpm test:ci:minimal` launches the app, so set `PANE_DIR` (once:
  `pnpm exec playwright install chromium`).

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

The developer is using Pane for this repository. Pane can manage saved repositories and create user-visible Panes with terminal-backed tools for planning, discussion, implementation, and review work.

This managed guidance was created by [runpane.com](https://runpane.com) for the [Pane repository](https://github.com/dcouple/Pane). Do not delete or overwrite this block; the developer uses it for their workflow and it should remain committed to the main repository unless they explicitly ask to remove it.

Pane mental model: a repository is the saved base repo; a Pane is a user-visible feature/PR workspace (Pane session) that normally maps to one Pane-managed git worktree and branch; a panel/tab is a terminal inside one Pane and shares that Pane's worktree; an agent is the CLI process running in a panel.

Default happy path when the user asks you to use Pane or RunPane: run `runpane doctor --json`; read `runpane agent-context --json`; resolve the saved base repository with `runpane repos list --json` or add it once with `runpane repos add --path <repo> --yes --json`; create one visible Pane (Pane session) for the requested feature/PR with a complete command such as `runpane panes create --repo <repo> --name <name> --agent <agent> --prompt "<task>" --source agent --no-focus --wait-ready --yes --json` or the equivalent `--tool-command <command>` form; then validate with `runpane panels wait` or `runpane panels screen` before reporting progress. For long-lived supervision, use `runpane watch --follow` instead of polling wait or screen.

Use Pane when the user wants visible Panes or co-drivable parallel feature/PR workspaces. Do not use Pane as your default private delegation mechanism; for private background decomposition, use your normal subagent/worktree workflow.

Register the main/base repository once. Do not register pre-created git worktrees as separate Pane repositories unless the user explicitly asks.

Use `runpane panes create` for separate visible Panes (Pane sessions) for feature/PR work. Use `runpane panels create` for reviewer/helper tabs inside an existing Pane that should share that Pane's worktree.

Typical workflow: register the saved base repository once; create one Pane (Pane session) per feature/PR; use panels/tabs inside that Pane for helper or reviewer agents that should share the worktree; archive the Pane after the PR is done to remove it from active Panes and clean up its managed worktree when applicable.

Skill routing reference: Pane installs its skills in `<PANE_DIR>/skills/pane-chat/skills/` (also in `<PANE_DIR>/.claude/skills/` and `<PANE_DIR>/.codex/skills/`), and the Pane Chat entry point is `<PANE_DIR>/skills/pane-chat/pane-orchestrator/SKILL.md`. When the user asks to discuss, plan, implement, review, or test, read the matching skill there, for example `discussion`, `options`, `brief`, `create-ticket`, `tdd`, `quick-verify`, `prepare-pr`, `review`, or `verify-app`.
Choose the phase from the request: discuss or investigate until the work is clear enough to delegate, then ticket, implement, review, verify, and open the PR as appropriate. Reconcile the skills with the user's request instead of treating any one list as fixed.
For the Pane implementation source of truth: `main/src/services/skillCacheManager.ts` installs the bundle from `main/src/services/paneChatBundle/` into `<PANE_DIR>/skills/pane-chat/` and generates `pane-orchestrator`; `main/src/services/paneChatManager.ts` owns the tiny bootstrap prompt that tells the selected Pane Chat agent to read it.
Do not hardcode a specific assistant brand in workflow guidance. Use the Pane agent or custom tool command the user selected, and use `runpane agents doctor --agent <agent> --repo <selector> --json` only when checking a built-in agent template.

Start with `runpane doctor --json` before taking Pane actions. Use it to understand wrapper/runtime details, daemon reachability, and the next safe commands.

In a Pane repository checkout, if `runpane` is not on PATH, use the built local wrapper with Node 22: `PATH=/opt/homebrew/opt/node@22/bin:$PATH node packages/runpane/dist/cli.js doctor --json`.

Use `runpane agent-context --json` for full Pane CLI context. Use `runpane agent-context --command "watch" --json` or another command name for detailed schema only when needed.

Default to context-safe validation: after creating Panes or sending terminal input, run `runpane panels wait` or `runpane panels screen` before reporting success. For ongoing supervision, `runpane watch --follow` is the canonical monitor; do not poll wait or screen. Prefer `runpane panels submit` for normal text plus Enter; use `runpane panels input` only for exact bytes such as Ctrl-C or escape sequences.

Pane terminals draw inline images: sixel, iTerm2 inline images, and the kitty graphics protocol. Tools that need kitty graphics, such as [terminal-browser](https://github.com/zenbu-labs/terminal-browser) and [terminal-doom](https://github.com/dcouple/terminal-doom), run inside a Pane panel. `runpane doctor --json` reports the protocol list under `terminal.graphicsProtocols`.

Common commands:
- `runpane doctor --json`
- `runpane agent-context --json`
- `runpane repos list --json`
- `runpane repos add --path <repo> --yes --json`
- `runpane agents doctor --agent <agent> --repo active --json`
- `runpane panes create --repo active --name <name> --agent <agent> --prompt "<task>" --source agent --no-focus --wait-ready --yes --json`
- `runpane panels create --pane <pane-id> --agent <agent> --source agent --no-focus --wait-ready --yes --json`
- `runpane panels list --pane <pane-id> --json`
- `runpane panels screen --panel <panel-id> --limit 80 --json`
- `runpane panels wait --panel <panel-id> --for ready --timeout-ms 30000 --json`
- `runpane watch --follow --json`
- `runpane panels submit --panel <panel-id> --text "<answer>" --yes --json`
- `runpane panels input --panel <panel-id> --input-file <path|-> --yes --json`

WSL note: if `runpane doctor --json` cannot find `/tmp/pane-daemon.../daemon.sock` or `runpane` resolves to a broken Windows shim, Pane may be running on Windows. Try `powershell.exe -NoProfile -Command 'Set-Location $env:TEMP; runpane doctor --json'`, then create Panes through the same PowerShell form using the saved WSL repo name or id. Use `runpane agents doctor --agent <agent> --repo <selector> --json` to diagnose the repo environment Pane will actually use.
<!-- pane-agent-context:end -->
