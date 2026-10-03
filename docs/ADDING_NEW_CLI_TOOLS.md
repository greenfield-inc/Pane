# Adding a New CLI Agent Tool

An agent tool in Pane is **not** a panel type and **not** a manager subclass. It is a
`type: 'terminal'` ToolPanel whose `customState.initialCommand` launches the CLI in a
PTY, plus a handful of data-driven registrations. This guide walks through every
integration point, using the Cursor Agent CLI (`cursor-agent`, agent id `cursor`) as
the worked example.

> Historical note: the `AbstractCliManager`/`cliToolRegistry`/panel-type-per-tool
> architecture was removed. Only Claude's deprecated session-level path still uses
> it. Do not build new tools on it.

For communication alone, no new built-in agent registration is required. Any CLI
agent can use [peer discovery and task messages](./AGENT_COMMUNICATION.md), including
an external process. Follow the steps below only to add a native Pane launch preset
and terminal-specific readiness/resume behavior.

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
- Add the id to `CLI_AGENT_TYPES` and its executable name(s) to
  `AGENT_EXECUTABLES`. The classifier parses the command into tokens (it sees
  through `env`, `command`, `exec` and shell `-c` wrappers) and matches the
  executable name exactly.

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
  install dir is typically off the GUI PATH.

## 7. Frontend

`shared/constants/agentLaunchPresets.ts` is the single list behind the toolbar pills,
Add Tool dropdowns (desktop + remote), and `mod+alt+N` hotkeys. Add one entry
(`platforms` gates unsupported OSes); `agentLaunchPresets.test.ts` pins the list
against the RunPane contract. Add the brand icon to
`frontend/src/components/ui/BrandIcons.tsx` and register it in `CLI_BRAND_ICONS`
(`frontend/src/components/ui/brandIconRegistry.ts`), and a search alias in
`frontend/src/components/settings/catalog.tsx`.

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
doctor), `agentLaunchPresets.test.ts`, `scripts/test-runpane-contract.js`.

## Agents launched through a wrapper

People often start a supported agent through their own command, such as
`agent-farm run free-range` or a shell script. The launch command then says
nothing about the agent, but Pane still needs to know it, because composer
detection, `panels submit` staging, the status manifest, `panels list` and the
workspace journal (`watch`) all depend on the panel's `agentType`.

Pane decides a terminal panel's agent in this order, and records the source in
`TerminalPanelState.agentDetection`:

1. **`declared`**: `--agent <id>` together with `--tool-command <command>` on
   `panes create`, `panes adopt` and `panels create`. On the wire this is
   `tool: { command, agentType }`. Here `--agent` means "the agent this command
   runs".
2. **`command`**: the launch command's executable word, through
   `resolveAgentTypeFromCommand` in `main/src/services/agents/agentIdentity.ts`.
3. **`process`**: the PTY's foreground process name, which node-pty reports as
   `pty.process`. The names `claude`, `codex` and `cursor-agent` map to agents.
   Claude Code's native installer runs `~/.local/share/claude/versions/<version>`,
   so it reports a bare version such as `2.1.283`. Pane resolves that name to an
   executable path with `ps` (or `/proc/<pid>/exe` on Linux) before trusting it.
   This source is skipped on Windows, WSL and ptyHost terminals, where node-pty
   cannot name the foreground program. A wrapper that stays in the foreground
   (for example a Node process that spawns the agent in its own process group)
   hides the agent from this check.
4. **`screen`**: Claude's closed rule/`❯`/rule composer box, or Codex's
   `OpenAI Codex` header with its `›` prompt
   (`main/src/services/agents/agentScreenSignature.ts`). Pane adopts it only after
   two consecutive status polls match. It ignores the check while Pane's own
   shell is in the foreground, so an agent's last frame left above a shell
   prompt does not count.

Pane runs the process and screen checks on the agent-status poll
(`TerminalPanelManager.pollAgentStatus`) until the panel's agent is known. Once
it is known, Pane:

- stores `agentType`, `agentDetection`, `launchCommand`, `isCliPanel: true` and
  `launchMode: 'wrapped'` on the panel's custom state;
- switches the panel to that agent's status manifest;
- restates the panel's current status, so watchers that ignored the panel so far
  see it from now on.

`launchMode: 'wrapped'` means the command is launched exactly as given.
`resolveCliLaunchCommand` never adds `--session-id`, resume flags or a prompt
argument to it. On restart, Pane runs the wrapper again, and the wrapper handles
its own resume. For the same reason, `--resume` is rejected for wrapper
commands.

A new built-in agent works with wrappers once its executable name is in
`AGENT_EXECUTABLES`. Add a screen signature only if the agent's UI has a stable,
distinctive frame.

## Delivery state and ghost text

`panels submit`, `panels submit-composer`, `agents send` and create prompts
report `delivery: { state, evidence }` for Claude and Codex. The state comes
from the agent's own transcript when Pane can find it
(`main/src/services/agentTranscript/`):

- Claude: `~/.claude/projects/<cwd, non-alphanumerics as '-'>/<session id>.jsonl`.
  Pane picks the session id (`--session-id`), except for wrapped launches, where
  it reads the worktree's recently written transcripts. A taken turn is a
  `type: "user"` entry. A message sent while Claude works is first a
  `queue-operation` `enqueue` entry, then a `user` entry once taken.
- Codex: the newest rollout under `~/.codex/sessions/YYYY/MM/DD/` whose
  `session_meta.cwd` is the worktree, or the rollout named by the thread id once
  Pane knows it. A taken turn is a `response_item` user message. Codex writes a
  queued message only once it takes it, so `queued` comes from its screen
  (`Messages to be submitted after next tool call` / `↳ <message>`).

The reader tails each file from a byte offset, so polling a long transcript
stays cheap. Without a transcript, the screen decides: a steadily empty composer
is `taken`, text still in it is `in-composer`.

The terminal model splits each screen into typed cells and ghost cells: dim
(SGR 2) or placeholder-grey text, which agents use for placeholders, prompt
suggestions and queued-message lists (`TerminalStateEmulator.getScreenText`).
Composer detection reads only typed cells; `panels screen` reports the ghost
text in the composer as `composer.ghostText`. A new agent whose placeholder is
neither dim nor mid-grey needs its own placeholder rule in
`agentScreenSignature.ts`.
