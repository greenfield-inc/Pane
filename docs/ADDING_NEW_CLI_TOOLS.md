# Adding a New CLI Agent Tool

An agent tool in Pane is **not** a panel type and **not** a manager subclass. It is a
`type: 'terminal'` ToolPanel whose `customState.initialCommand` launches the CLI in a
PTY, plus a handful of data-driven registrations. This guide walks through every
integration point, using the Cursor Agent CLI (`cursor-agent`, agent id `cursor`) as
the worked example.

> Historical note: the `AbstractCliManager`/`cliToolRegistry`/panel-type-per-tool
> architecture was removed. Only Claude's deprecated session-level path still uses
> it. Do not build new tools on it.

## 0. Learn the CLI first

Before writing code, verify against the real binary (see the Cursor example):

- Launch command and permission-skip flags (`cursor-agent --force --trust`).
- Whether the prompt can be passed as a positional argument, including slash-prefixed
  input (Cursor: yes, unconditionally → argument delivery).
- Session/resume mechanics (Cursor: `create-chat` pre-creates an id; `--resume <id>`;
  `--continue` for latest).
- Screen frames for status detection: idle composer, working/spinner, approval
  prompts, first-run dialogs. Capture raw PTY bytes with a `pty` harness and distil
  them into test fixtures.
- Whether the TUI uses the alternate screen and whether it repaints while idle.

## 1. Register the agent in the RunPane contract

`contracts/runpane/contract.json`:

- Add the id to `enums.agents`.
- Add `agentTemplates.<id> = { title, command, description }`.
- Update `<codex|claude|cursor>` usage strings.
- Run `pnpm run generate-runpane-contract` and commit all regenerated artifacts.
- `scripts/test-runpane-contract.js` (`checkAgentTemplateParity`) loops over the agent
  enum, so the new agent is exercised automatically.

## 2. Teach the classifier the new binary

`main/src/services/agents/agentIdentity.ts` is the **single** command→agent
classifier (used by terminalPanelManager, sessionManager, and shutdown marking).

- Widen `TerminalPanelState['agentType']` in `shared/types/panels.ts`.
- Add the id to `CLI_AGENT_TYPES` and a token-boundary regex to
  `AGENT_COMMAND_PATTERNS` (order matters when one binary name contains another).

## 3. Launch/resume branches

`main/src/services/terminalPanelManager.ts` → `resolveCliLaunchCommand` gets a branch
per agent: fresh launch (optionally with the prompt as a quoted argument), and
interrupted-resume (`wasInterrupted` + `agentSessionId`). Keep agent-specific string
building in a pure module next to `agents/cursorLaunch.ts` so it is unit-testable.

If the CLI owns its session ids, scrape them from PTY output via
`captureAgentSessionId` (add an extractor to `extractAgentSessionId`'s dispatch). If
launch readiness cannot key on first PTY byte (e.g. shell traffic precedes the TUI),
add a ready detector like `createCursorReadyDetector` and gate `signalCliReady` on it.

## 4. Status manifest

`main/src/services/agentStatus/manifests.ts`: write a `<TOOL>_MANIFEST` from captured
fixtures and register it in `MANIFESTS_BY_AGENT`. Unknown agents fall back to
`GENERIC_MANIFEST` (works, less precise). Keep blocker rules narrow and live-region
gated so answered prompts in scrollback don't stick. Record the CLI version the
fixtures came from.

## 5. Restart/auto-resume

`main/src/services/agents/agentResume.ts` → `resolveResumeId` maps the agent to the
resume id shown in the resume dialog. `sessionManager.resumeInterruptedSessions` and
the `index.ts` graceful-shutdown path are agent-generic once the classifier knows the
binary.

## 6. RunPane IPC

`main/src/ipc/runpane.ts`:

- `shouldUseArgumentDelivery` — how the initial prompt reaches the CLI.
- `runAgentDoctor` — add fallback binary paths (`AGENT_FALLBACK_BIN_PATHS`) when the
  install dir is typically off the GUI PATH, and unsupported environments
  (`AGENT_UNSUPPORTED_ENVIRONMENTS`).

## 7. Frontend

`shared/constants/agentLaunchPresets.ts` is the single list behind the toolbar pills
and Add Tool dropdowns (desktop + remote). Add one preset entry with its stable
`hotkeyId` (`platforms` gates unsupported OSes), then add the matching command and
default chord to `shared/constants/keyboardShortcuts.ts`.
`agentLaunchPresets.test.ts` and `keyboardShortcutCatalog.test.ts` pin preset,
catalog, platform, and default-chord parity. Add the brand icon to
`frontend/src/components/ui/BrandIcons.tsx` (`CLI_BRAND_ICONS`) and a search alias in
`frontend/src/components/settings/catalog.tsx`. Settings → Shortcuts, Help, and the
conflict engine read the catalog directly, so a new agent's launch command becomes
remappable (and conflict-checked against every other binding) with no further UI work.

## 8. Worktree file sync

If the CLI reads a config directory (like `.cursor/`), add it to
`DEFAULT_WORKTREE_FILE_SYNC_ENTRIES` in `shared/types/worktreeFileSync.ts` so it is
copied into new worktrees.

## 9. Pane Chat (optional)

To offer the agent as a Pane Chat orchestrator: widen `PaneChatAgent` and the panel-id
maps in `shared/types/paneChat.ts`, extend `paneChatManager` (title, session-id
strategy, bootstrap prompt), and teach `skillCacheManager` to emit the orchestrator
guide in a format the CLI actually reads (Cursor: `.cursor/rules/*.mdc`).

## 10. Tests are the spec

Every step above lands test-first: `agentIdentity.test.ts`, `<tool>Launch.test.ts`,
`terminalPanelManager.test.ts`, `agentResume.test.ts`, `manifests.test.ts` +
`agentStatusPipeline.test.ts` (real captured bytes), `runpane.test.ts` (agent matrix +
doctor), `agentLaunchPresets.test.ts`, `keyboardShortcutCatalog.test.ts`,
`scripts/test-runpane-contract.js`.
