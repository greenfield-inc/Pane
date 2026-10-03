# Test boundaries

Renderer tests (`pnpm test`, `pnpm test:ci`, and `pnpm test:ci:minimal`)
start Vite and use Chromium with the explicit Electron API fixture. They test
rendering and user interaction. Use Playwright locators (`click`, `fill`, and
assertions) so hidden, covered, or disabled controls fail as they would for a
user. `PLAYWRIGHT_PORT` selects an isolated server for concurrent worktrees.

The separate `scripts/smoke-sandboxed-preload.cjs` check runs Electron with
context isolation, no Node integration, and the actual bundled sandboxed
preload. It probes the shared daemon channel ownership matrix and Electron-only
exceptions. Keep it in CI when changing renderer tests; the mocked browser
fixture does not cover IPC or preload execution.

Main Vitest setup creates a temporary `PANE_DIR` before service imports can open
SQLite. Keep that isolation even when a suite supplies explicit dependencies.
TerminalPanelManager accepts its panel persistence/event interface in the
constructor; only the terminal unit and persistence suites pass a fake. The
Vitest resolver must not silently replace service imports for unrelated suites.

Architectural import restrictions live in `main/eslint.config.js`. Targeted
services use the core runtime and event sink; daemon transport does not import
Electron or the desktop bootstrap. Preload routing is verified by the real
Electron smoke test rather than matching source spelling.

`pnpm deadcode` retains the comprehensive Knip check including tests and build
tooling. `pnpm deadcode:production` additionally examines shipped entrypoints
without tests keeping unused exports reachable. Production patterns in
`knip.json` end in `!`: keep the desktop, renderer, remote renderer, headless
daemon, preload, PTY host and standalone MCP bridge entries current. Test
fixtures remain in the comprehensive graph only. Review production findings as
code ownership issues; do not broadly suppress categories to make the report
clean.
