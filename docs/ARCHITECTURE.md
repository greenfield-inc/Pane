# Pane architecture

This is an index of how Pane fits together. It names the owning files; the code
is the reference for details.

## Words

- **Repository (project):** a saved base git repo.
- **Pane (session):** one feature or PR workspace. It normally owns one
  Pane-managed git worktree and branch.
- **Panel:** a tab inside a pane. Types are `terminal`, `diff`, `explorer`,
  `editor`, `logs`, `dashboard`, `setup-tasks` and `browser`
  (`shared/types/panels.ts`). Agent CLIs run in `terminal` panels.

## Processes

```
renderer (frontend/, React)  ──IPC via preload──▶  main process (main/src)
                                                     │  services, SQLite, git
remote PWA / mobile ──HTTP + SSE──▶ daemon ◀──socket── runpane CLI
                                                     │
                                                 ptyHost (optional utility process)
```

- **Main process** (`main/src/index.ts`) owns native integration, git
  worktrees, CLI processes and persistence. Business logic lives in
  `main/src/services/`; IPC handlers live in `main/src/ipc/`.
- **Preload** (`main/src/preload.ts`) is bundled with esbuild because the
  renderer is sandboxed (`scripts/verify-sandboxed-preload.js` checks it). It
  sends each invoke either to the main process or to the daemon, decided by
  `isDaemonOwnedChannel` in `shared/types/daemon.ts`. Keep ownership lists in
  that module, and run `pnpm build:main` to check the bundle still loads.
- **Renderer** (`frontend/src`) is React with Zustand stores
  (`frontend/src/stores`). `frontend/index.html` is the desktop app;
  `frontend/remote.html` is the Remote PWA that `mobile/` also bundles.
- **Daemon** (`main/src/daemon`) serves the command registry over a local
  socket (a `pane-daemon-*` directory under the system temp directory, or a
  named pipe on Windows). The `runpane` CLI talks to it. For Remote Pane it also
  serves HTTP and SSE (`httpApiServer.ts`). `pnpm daemon:headless` runs it
  without a window. Remote setup and lifecycle:
  [SELF_HOSTED_REMOTE_DAEMON.md](SELF_HOSTED_REMOTE_DAEMON.md) and
  [remote-daemon-lifecycle.md](remote-daemon-lifecycle.md).
- **ptyHost** (`main/src/ptyHost`) runs PTYs in an Electron utility process.
  It is on by default on Windows (`usePtyHost` in `configManager.ts`), and
  `PANE_USE_PTY_HOST=1` turns it on elsewhere. Otherwise PTYs run in the main
  process. See [troubleshooting/WINDOWS_APP_HANG.md](troubleshooting/WINDOWS_APP_HANG.md).

## Terminal output

PTY output goes through `terminalPanelManager.ts`, which batches it and applies
flow control. It feeds a headless xterm emulator (`terminalStateEmulator.ts`),
whose serialization restores a terminal when its panel is shown again, and
stores capped scrollback in the `panel_buffers` table. The renderer draws with
xterm.js in `frontend/src/components/panels/TerminalPanel.tsx`. The comment
above that component describes the activation lifecycle; read it before you
change how panels show, hide or refresh.

Agent status (working, idle, blocked) is derived in
`main/src/services/agentStatus/`.

## Data

- The data directory is `~/.pane` for an installed app. `--pane-dir` or
  `PANE_DIR` overrides it (`main/src/utils/appDirectory.ts`).
- `sessions.db` is SQLite in WAL mode. The base schema is
  `main/src/database/schema.sql`; later changes are inline migrations in
  `main/src/database/database.ts` that run at startup.
- `config.json` holds app settings (`main/src/services/configManager.ts`,
  types in `main/src/types/config.ts`).
- Worktrees go in `<repo>/worktrees/` unless the project sets another folder
  (`worktreeManager.ts`). `worktreePoolManager.ts` keeps empty reserve
  worktrees on `_reserve/<hex>` branches so new panes open fast.
- Per-repo setup, run and archive scripts come from `pane.json` and friends:
  [CONFIG_FILES.md](CONFIG_FILES.md).

## Subsystems

| Area | Owner | Doc |
| --- | --- | --- |
| Adding an agent CLI | `main/src/services/agents/` | [ADDING_NEW_CLI_TOOLS.md](ADDING_NEW_CLI_TOOLS.md) |
| Panels | `panelManager.ts`, `shared/types/panels.ts` | [TOOL_PANEL_SYSTEM.md](TOOL_PANEL_SYSTEM.md) |
| Renderer updates | IPC events in `main/src/events.ts` | [STATE_MANAGEMENT.md](STATE_MANAGEMENT.md) |
| Timestamps | `main/src/utils/timestampUtils.ts` | [TIMESTAMP_HANDLING.md](TIMESTAMP_HANDLING.md) |
| Pane Chat and orchestration sessions | `paneChatManager.ts`, `skillCacheManager.ts`, `paneChatBundle/` | [SESSIONS.md](SESSIONS.md) |
| `runpane` CLI contract | `contracts/runpane/` | [RUNPANE_CLI_CONTRACT.md](RUNPANE_CLI_CONTRACT.md) |
| Analytics | `analyticsManager.ts`, `frontend/src/services/posthog.ts` | [ANALYTICS_INVARIANTS.md](ANALYTICS_INVARIANTS.md) |
| Themes | `frontend/src/styles/tokens/colors.css` | [APPEARANCE.md](APPEARANCE.md), [scripts/README.md](../scripts/README.md) |
| Usage and cost | `main/src/services/usage/` | [usage/README.md](../main/src/services/usage/README.md) |
| Mobile companion | `mobile/` | [NATIVE_MOBILE.md](NATIVE_MOBILE.md) |

## Rules that follow from this design

- Run project commands through the asynchronous `CommandRunner` and
  `CommandExecutor` (`main/src/utils/`). Await results through IPC and the
  lifecycle callers, drop results from stopped or replaced watchers, and
  serialize Spotlight checkouts with restoration.
- For git status in WSL, watch from inside the distro: prefer `inotifywait`.
  Without it, Pane polls `git status` in the distro every five seconds while
  focused. Don't add Windows-side recursive watchers over `\\wsl.localhost` or
  `\\wsl$`.
- Production builds must never include React Scan (`pnpm perf:scan` is dev
  only).
