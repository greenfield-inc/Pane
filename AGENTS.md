# Repository Guidelines

## Project Structure & Module Organization
- Root `pnpm` workspace with packages: `main/` (Electron main process, TypeScript), `frontend/` (React + Vite), `shared/` (shared types), and `tests/` (Playwright E2E).
- Key paths: `main/src/{services,ipc,utils}/`, `frontend/src/{components,hooks,stores,utils}/`, `main/assets/`, `scripts/`.
- Build artifacts: `frontend/dist/`, `main/dist/`, packaged output `dist-electron/`.
- Pane is an Electron desktop app: the main process owns native integration, CLI processes, git worktrees, and SQLite persistence; the preload bridge exposes IPC to the React renderer.
- When adding or changing CLI integrations, follow `docs/ADDING_NEW_CLI_TOOLS.md` and `docs/IMPLEMENTING_NEW_CLI_AGENTS.md`.

## Build, Test, and Development Commands
- Dev app: `pnpm dev` (spawns frontend + Electron). The launcher waits for `tsc -w`'s first emit and re-bundles `main/dist/main/src/preload.js` with esbuild (the plain tsc emit cannot load in the sandboxed preload, which leaves the renderer on the browser fallback screen); it keeps re-bundling whenever tsc overwrites it.
- Build all: `pnpm build` (frontend, main, then electron package).
- Package (examples): `pnpm build:mac`, `pnpm build:linux`.
- Lint: `pnpm lint`; Type-check: `pnpm typecheck` (runs per package). The root lint command is the single entry point for blocking Oxlint and Knip checks, residual ESLint, and advisory anti-slop checks.
- Detailed advisory output: `pnpm lint:ox:extra:details`; accessibility scan: `pnpm a11y:scan` (install Chromium once with `pnpm exec playwright install chromium`); opt-in render evidence: `pnpm perf:scan`.
- Tests (E2E): `pnpm test`, `pnpm test:ui`, CI configs in `playwright.ci*.config.ts`.
- Themes: `pnpm theme:contrast` gates the 15 batch themes' token pairs in `frontend/src/styles/tokens/colors.css` (text/UI/terminal contrast, high-contrast overlay, CVD separation; `--all` reports the original twelve, `--themes a,b` picks themes, `--markdown --cvd` prints PR tables — see `scripts/README.md`); `pnpm theme:screenshots` regenerates `screenshots/themes/batch/`.
- Main unit tests (if added): `pnpm --filter main test`, coverage: `pnpm --filter main run test:coverage`.
- Releases must follow `docs/RELEASE_INSTRUCTIONS.md` and run from a clean `main` checkout whose `HEAD` matches `origin/main`.

## Coding Style & Naming Conventions
- Use TypeScript throughout; follow ESLint configs in `frontend/eslint.config.js` and `main/eslint.config.js`.
- Indentation 2 spaces; prefer explicit types at module boundaries.
- Naming: `camelCase` for variables/functions, `PascalCase` for React components/types, `kebab-case` for filenames (React files may match component name).
- Do not introduce explicit `any`; use a specific type or `unknown` with narrowing. ESLint enforces `@typescript-eslint/no-explicit-any` at error level.
- Run `pnpm lint && pnpm typecheck` before sending PRs.

## Testing Guidelines
- E2E tests live in `tests/*.spec.ts` (Playwright). Example: `pnpm test -- tests/smoke.spec.ts`.
- Add Playwright tests for user-visible flows; mock external services where possible.
- For backend logic in `main/`, use Vitest colocated under `main/src/**/__tests__` or `*.spec.ts`.

## Commit & Pull Request Guidelines
- Commits: present tense, focused, reference issues (e.g., "Fix session diff flicker, closes #123").
- PRs must include: clear description, linked issues, testing notes; screenshots/GIFs for UI changes.
- If dependencies change, run `pnpm run generate-notices` and commit updated `NOTICES`.

## Security & Configuration Tips
- The root development toolchain requires Node >= `22.18`; `pnpm` >= `8`. Use `pnpm` only. Electron 41 bundles Node 24 for the app, while the published `packages/runpane` wrapper intentionally supports Node >= `20`.
- Secrets via `.env` (dotenv) for local dev; never commit secrets.
- To avoid clobbering local data when hacking on Pane with Pane: `PANE_DIR=~/.pane_test pnpm dev`.

## Agent Notes (for automation)
- Keep changes minimal and scoped; prefer small patches.
- Treat blocking lint as the new-code floor. Every Knip category is blocking; advisory anti-slop output records existing debt. Address relevant findings without broad suppressions. See `references/anti-slop.md` and `references/oxlint-overlap.md`.
- `pnpm perf:scan` enables React Scan only for that Vite dev session and emits `[render-evidence]` summaries for pane switching and Remote PWA churn. Production builds must never include React Scan. Component counts do not measure xterm/WebGL, Electron main-process, IPC, or network cost.
- For WSL git-status work, keep filesystem watching inside the distro: prefer `inotifywait`; without it Pane intentionally falls back to a five-second WSL-native `git status` poll while focused. Do not add Windows-side recursive watchers over `\\wsl.localhost` or `\\wsl$`.
- Development runs capture renderer and main-process output in root `frontend-debug.log` and `backend-debug.log`; inspect those logs when reproducing app failures. They are reset when development starts.
- Update docs alongside code; do not alter build targets without discussion.
- Use repository scripts (pnpm) and keep formatting consistent with existing files.
- Route preload invokes with `isDaemonOwnedChannel` from `shared/types/daemon.ts`; the preload bundle inlines it. Keep ownership lists in that shared module, including the distinction between Electron-only actions and daemon active-session hints. Run `pnpm build:main` to verify sandbox compatibility.
- Use the asynchronous `CommandRunner`/`CommandExecutor` APIs for project commands. Await results through IPC and lifecycle callers, discard results from stopped/replaced watchers, and serialize Spotlight checkouts with restoration.
- For RunPane local-control debugging on macOS, test against an isolated Pane directory (for example `PANE_DIR=~/.pane_test pnpm dev`) and validate with the local wrapper (`node packages/runpane/dist/cli.js doctor --json --pane-dir ~/.pane_test`, then `repos list`, `repos add --path ... --yes`, and `panes list`). Use Node 22 for repo scripts; if switching between Vitest/plain Node and Electron dev runs, rebuild native modules for the target runtime (`npm rebuild better-sqlite3-multiple-ciphers` for Node, `pnpm electron:rebuild` for Electron).

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

Skill routing reference: when the user says `discussion`, `plan`, `simple-plan`, `create-plan`, or `implement`, or asks for the behavior those words imply, treat three references as peer context: Pane's local skill cache under `<PANE_DIR>/skills/`, the Pane Chat orchestrator handoff at `<PANE_DIR>/skills/pane-chat/runpane-orchestrator.md` when present, and the [workflow map](https://github.com/dcouple/skills/raw/main/docs/readme-workflow-map.png).
Use those peer references together to choose the phase: discuss/investigate until the work is clear enough to delegate, then ticket/plan/implement/review/PR-test/teach-back as appropriate. The orchestrator and workflow map may point to different skills; reconcile them with the user's request instead of hardcoding a skill list or treating one reference as subordinate.
For the Pane implementation source of truth for where the skill cache, cached workflow assets, and Pane Chat bootstrap live, reference [PR #291](https://github.com/dcouple/Pane/pull/291): `main/src/services/skillCacheManager.ts` owns `<PANE_DIR>/skills/`, `.sources/dcouple-skills`, and `pane-chat/runpane-orchestrator.md`; `main/src/services/paneChatManager.ts` owns the tiny bootstrap prompt that tells the selected Pane Chat agent to read that guide.
Use GitHub reads against the [Parsa skills folder](https://github.com/dcouple/skills/tree/main/parsa) only to inspect or refresh referenced skill files; do not clone/install the repo unless the user asks.
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

## README artwork

Follow `docs/assets/visual-style.md` for README illustrations. Use this repository's banner as the image reference, preserving the shared dcouple pixel-art language and the project-specific setting and colors.
