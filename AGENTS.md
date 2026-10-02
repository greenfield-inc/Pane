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
- For RunPane local-control debugging on macOS, test against an isolated Pane directory (for example `PANE_DIR=~/.pane_test pnpm dev`) and validate with the local wrapper (`node packages/runpane/dist/cli.js doctor --json --pane-dir ~/.pane_test`, then `repos list`, `repos add --path ... --yes`, and `panes list`). Use Node 22 for repo scripts; if switching between Vitest/plain Node and Electron dev runs, rebuild native modules for the target runtime (`npm rebuild better-sqlite3-multiple-ciphers` for Node, `pnpm electron:rebuild` for Electron). Only one ABI can be present at a time, so rebuild for whichever runtime you are about to use. `electron:rebuild` passes `--only better-sqlite3-multiple-ciphers` on purpose, and `--only` rather than `-w`: `-w` *adds* to the auto-detected set instead of restricting it, which drags in `bull`'s transitive `msgpackr` -> `msgpackr-extract` and fails under node-gyp on any machine without a C++ toolchain. Nothing is lost by scoping it out — `msgpackr-extract` publishes no `win32-arm64` prebuild at all, so Pane's Windows arm64 builds already run on `msgpackr`'s pure-JS fallback. `@lydell/node-pty` is unaffected either way: it resolves a prebuilt `@lydell/node-pty-<platform>-<arch>` package (including `win32-arm64`) that carries N-API binaries under `prebuilds/` with no `binding.gyp`, so electron-rebuild never had anything to rebuild there. `--only` filters modules, not architecture, so a rebuild on an arm64 host still targets arm64.

<!-- pane-agent-context:start -->
## Pane

This repository is used with [Pane](https://runpane.com). Drive it with the CLI or the `pane` MCP server.

CLI: `npm i -g runpane` (or `npx --yes runpane@latest`), then `runpane doctor --json`. Full command reference: `runpane agent-context --json`.

MCP: packaged Pane registers a stdio server named `pane` with Claude Code, Codex, and Cursor. Check the connection with `claude mcp list`, `codex mcp list`, or `agent mcp list`. Cursor may ask you to enable `pane` with `agent mcp enable pane`. If tools are missing, add it in the agent's MCP settings: Claude Code `claude mcp add --scope user pane -- npx --yes runpane@latest mcp`; Codex (`~/.codex/config.toml`) table `[mcp_servers.pane]` with `command = "npx"` and `args = ["--yes", "runpane@latest", "mcp"]`; Cursor (`~/.cursor/mcp.json`) uses `mcpServers.pane` with the same `npx` command and args; any other stdio client uses them too.
<!-- pane-agent-context:end -->

## README artwork

Follow `docs/assets/visual-style.md` for README illustrations. Use this repository's banner as the image reference, preserving the shared dcouple pixel-art language and the project-specific setting and colors.
