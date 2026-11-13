# Adding a New CLI Agent Tool

An agent in Pane is an entry in the agents config, `agents.entries` in
`contracts/runpane/contract.json`. It runs in a `type: 'terminal'` ToolPanel
whose `customState.initialCommand` launches the CLI in a PTY, and, when its entry
has a `chat` section, in chat tabs over ACP ([CHAT_TABS.md](CHAT_TABS.md)).
Menus, hotkeys, labels, command detection and chat tabs read the config, so a
new agent starts as one config entry. Terminal resume and status detection
still need code per agent. This guide uses the Cursor Agent CLI
(`cursor-agent`, agent id `cursor`) as the worked example.

## 0. Learn the CLI first

Before writing anything, verify against the real binary:

- Launch command and permission-skip flags (`cursor-agent --force --trust`).
- Whether it speaks ACP itself (`cursor-agent acp`), its oldest version that
  does, and how it signs in (`cursor-agent login`, or an API key variable).
- Whether the prompt can be passed as a positional argument, including slash-prefixed
  input (Cursor: yes, unconditionally → argument delivery).
- Session/resume mechanics (Cursor: `create-chat` pre-creates an id; `--resume <id>`;
  `--continue` for latest).
- Screen frames for status detection: idle composer, working/spinner, approval
  prompts, first-run dialogs. Capture raw PTY bytes with a `pty` harness and distil
  them into test fixtures.
- Whether the TUI uses the alternate screen and whether it repaints while idle.

## 1. Add a config entry

Add the agent to `agents.entries` and its id to `enums.agents` in
`contracts/runpane/contract.json`; the generator fails unless the two list the
same ids. The schema is `$defs/agent` and `$defs/agentChat` in
`contracts/runpane/schema.json`.

| Field | What it is |
| --- | --- |
| `title`, `label` | Full name (terminal tab titles) and short name (menus, chat headings) |
| `icon` | Key into the clients' brand icon registry; an unknown key gets a generic icon |
| `description` | One line for Settings → Agents |
| `executables` | CLI names on PATH; the first launches, all of them identify the agent in a command or process |
| `terminal.args`, `terminal.fullAccessArgs` | The terminal launch command is the first executable, then `fullAccessArgs`, then `args` |
| `terminal.hotkey` | Default key for "Add <title>"; it must conflict with no other key |
| `terminal.platforms` | Platforms the agent runs on, when not all |
| `terminal.reportsConversation` | Pane's `SessionStart` hook reports the terminal's live conversation (Claude only) |
| `terminal.promptArgument` | The CLI takes the starting message as a command argument. Without it, Pane types the message once the status manifest shows the agent's idle input box (below) |
| `terminal.configDir` | The CLI's project config folder (`.claude`), copied into new worktrees by default |
| `terminal.session` | How the CLI opens a saved conversation: `flag`, `minimumVersion` (the doctor checks `--help` for the flag), `idPattern`, `selectors` (flags with which a command picks its own conversation) and `paneChoosesId` (the flag also creates the conversation, so Pane picks the id) |
| `install` | Install page `url` and install `command`, shown when the CLI is missing or too old |
| `signIn` | Arguments to the CLI that sign it in, run in a terminal tab when a chat agent advertises no terminal sign-in of its own; required with `chat` |
| `onboarding` | Offered on the first-run screen |
| `chat` | Present when chat tabs run the agent (below) |

`chat` fields:

| Field | What it is |
| --- | --- |
| `args` or `adapter` | Exactly one: arguments that start the CLI as an ACP agent (`["acp"]`), or a bundled adapter package (pinned in `package.json`) with the variable that points it at the CLI |
| `minimumVersion` | Oldest CLI version chat supports |
| `apiKeyEnv` | Variables an API key saved in Settings is passed as |
| `fullAccess` | `mode` (a session mode that never asks) or `args: true` (pass `terminal.fullAccessArgs` to the chat CLI); absent, Pane answers each approval with allow once |
| `riskyModes` | Session modes in which the agent acts without asking; viewers mark them |
| `terminalConversationsLoad` | A chat can load a conversation the agent's terminal started (Switch to chat) |
| `legacyClients` | Pane apps from before the agent catalog may show its chat tabs; leave it off for a new agent |
| `registryIds` | ACP Registry ids this entry covers |

Then:

- Regenerate with `node scripts/generate-runpane-contract.js` (or `pnpm run
  generate-runpane-contract`) and commit every generated file, including
  `shared/types/generatedAgents.ts` and `docs/RUNPANE_CLI_CONTRACT.md`.
- Update the hand-written `<codex|claude|cursor…>` usage strings in the
  contract, and the agent list `scripts/test-runpane-contract.js`
  (`checkAgentTemplateParity`) pins.
- A new `chat.adapter` package also goes in `package.json` and `main/package.json`
  as an exact version, and in `ADAPTERS` in `scripts/verify-chat-adapters.js`.

What derives from the entry with no further code:

- Terminal launch presets, the toolbar pills and Add Tool menus on desktop,
  PWA and phone (`shared/constants/agentLaunchPresets.ts`).
- The "Add <title>" shortcut and its default key
  (`shared/constants/keyboardShortcuts.ts`), so Keyboard Shortcuts, Help, the
  palette and the conflict check cover it.
- Command and foreground-process detection: `AGENT_EXECUTABLES` and
  `CLI_AGENT_TYPES` in `main/src/services/agents/agentIdentity.ts`, and the
  `TerminalPanelState['agentType']` type.
- Pane Chat and Sessions: `PaneChatAgent`, its labels
  (`PANE_CHAT_AGENT_LABELS`), panel ids and validators in
  `shared/types/paneChat.ts`.
- `runpane --agent <id>`, the agent doctor's launch command and its `--help` check for `terminal.session.flag`.
- How the starting message is delivered (`terminal.promptArgument`), and the
  default worktree file sync row (`terminal.configDir`).
- For `terminal.session.paneChoosesId`: the launch and every relaunch add the
  flag with a Pane-chosen id (`agents/chosenSessionLaunch.ts`), the resume
  dialog, `--resume` checks and the update reopen read the same fields.
- Chat tabs, for an entry with `chat`: launch, version check, API key, sign-in,
  full access, the host's agent catalog, Settings → Agents and Switch to chat.
  A Session orchestrator for it opens as a chat tab when chat tabs are on.
- The Settings search alias (its label).

Code never hard-codes an agent fact: an id, executable, session mode or
minimum version as a string literal, or an env var name the config lists.
`scripts/check-agent-names.mjs` (part of `pnpm lint`, so CI runs it) fails on
one outside `scripts/agent-names-allowlist.json`, which lists each exempt file
with its reason and the number of such literals it may hold. The count may only
fall. The per-agent code below lives in files already on that list; a new
literal there means raising its count, which review sees.

## 2. Terminal launch and resume

`main/src/services/terminalPanelManager.ts` → `resolveCliLaunchCommand` gets a branch
per agent that resumes differently: fresh launch (optionally with the prompt as a quoted argument), and
interrupted-resume (`wasInterrupted` + `agentSessionId`). Keep agent-specific string
building in a pure module next to `agents/cursorLaunch.ts` so it is unit-testable.

If the CLI owns its session ids, scrape them from PTY output via
`captureAgentSessionId` (add an extractor to `extractAgentSessionId`'s dispatch). If
launch readiness cannot key on first PTY byte (e.g. shell traffic precedes the TUI),
add a ready detector like `createCursorReadyDetector` and gate `signalCliReady` on it.

OpenCode creates its own `ses_*` id on the first message and refuses `--session`
for an id it did not create, so a new conversation starts bare. Pane saves the id
from the line OpenCode prints after leaving its TUI (`Continue  opencode -s <id>`),
persists it before the next spawn and resumes it with `--session`. Ids from Pane's
earlier allocator (`ses_` + 32 lowercase hex) are dropped. Its idle composer gates readiness and
once-only stdin prompt delivery; wrapped commands remain opaque. RunPane doctor
checks the installed executable's session capability before reporting support.

Pi takes a caller-chosen id, so its entry sets `terminal.session.paneChoosesId`:
`pi --session-id <id>` opens the working folder's session with that id and
creates it when there is none. Pane allocates a UUID for a direct `pi` launch,
saves it as the panel's `agentSessionId` and runs the same command on every
relaunch. A command that picks its own session (a `selectors` flag or its own
`--session-id`), runs a subcommand (`pi auth login`), has a `--` or runs pi
through a wrapper or shell syntax runs unchanged, and `--resume` is refused for
it. Pi has no `promptArgument`: as an argument, pi reads a leading `@` as a
file to attach and sends a slash command to the model as text.

A held starting message waits for positive evidence of the agent's own input
box: its manifest's `visibleIdle` rule, or the composer signature in
`agentScreenSignature.ts` (Claude, Codex). An idle status alone is not enough,
because a screen no rule recognizes also reads idle, and Enter there could
answer a prompt such as pi's project-trust question, whose first option is
Trust. After 30 seconds without the input box, Pane records on the panel that
it is holding the message and keeps holding it. `--wait-ready` waits for the
same input box. For an agent without `promptArgument`, `panels submit` (and so
`agents send` and Notify's owed answers) types only when the manifest
recognizes the input box, idle (`visibleIdle`) or mid-turn (`visibleWorking`),
and nothing blocks it. So a typed-message agent needs a `visibleIdle` rule, and
blocked rules for every prompt or dialog that can replace its input box. Pi
keeps its footer and widgets below a dialog, so pi's `live_dialog` scans the
whole visible screen for a dialog frame: a border row, then the highlighted
option (`→ `) or the key hint ending in `cancel`, then a border row. Such a
frame anywhere reads blocked, which holds rather than guesses. Loops and handoff session
carrying do not offer pi yet.

`main/src/services/agents/agentResume.ts` → `resolveResumeId` maps the agent to the
resume id shown in the resume dialog. `sessionManager.resumeInterruptedSessions` and
the `index.ts` graceful-shutdown path are agent-generic once the classifier knows the
binary.

## 3. Status manifest

`main/src/services/agentStatus/manifests.ts`: write a `<TOOL>_MANIFEST` from captured
fixtures and register it in `MANIFESTS_BY_AGENT`. Unknown agents fall back to
`GENERIC_MANIFEST` (works, less precise). Keep blocker rules narrow and live-region
gated so answered prompts in scrollback don't stick. Record the CLI version the
fixtures came from.

## 4. RunPane IPC

`main/src/ipc/runpane.ts`:

- `shouldUseArgumentDelivery`: argument delivery for an agent with
  `terminal.promptArgument` (Codex keeps slash commands typed).
- `runAgentDoctor`: add fallback binary paths (`AGENT_FALLBACK_BIN_PATHS`) when the
  install dir is typically off the GUI PATH.

## 5. Icons and worktree file sync

Add the brand icon to `frontend/src/components/ui/BrandIcons.tsx` and register
it under the entry's `icon` key in `CLI_BRAND_ICONS`
(`frontend/src/components/ui/brandIconRegistry.ts`), and a stand-in symbol in
the phone's `BRAND_ICONS` (`native/src/app/pane/[paneId]/new-panel.tsx`).
Without them the agent gets the generic icon.

If the CLI reads a project config folder (like `.cursor/`), set
`terminal.configDir`; `DEFAULT_WORKTREE_FILE_SYNC_ENTRIES` in
`shared/types/worktreeFileSync.ts` copies it into new worktrees.

## 6. Sessions in a terminal

A Session orchestrator in a terminal reuses the terminal's native conversation
identity and launch/resume support; do not allocate a second orchestrator
identity or replay a bootstrap prompt. Sessions emit generated `AGENTS.md`
instructions. OpenCode uses that existing context without new OpenCode
skill/MCP installation and retains its default `opencode --auto` behavior:
non-denied operations are auto-approved, not sandboxed.

OpenCode Session launches must be supported direct commands; wrappers and custom
resume templates are rejected. Saved IDs restore history when it exists. Closing, archiving, switching, or PTY exit
does not add a guarantee that shared-service work has stopped.

## 7. Tests are the spec

Every step above lands test-first: `agentIdentity.test.ts`, `<tool>Launch.test.ts`,
`terminalPanelManager.test.ts`, `agentResume.test.ts`, `manifests.test.ts` +
`agentStatusPipeline.test.ts` (real captured bytes), `runpane.test.ts` (agent matrix +
doctor), `agentLaunchPresets.test.ts`, `keyboardShortcutCatalog.test.ts`,
`scripts/test-runpane-contract.js`. For chat, run the chat tab suites against
the real CLI's ACP mode.

## Agents launched through a wrapper

People often start a supported agent through their own command, such as
`agent-farm run free-range` or a shell script. The launch command then says
nothing about the agent, but Pane still needs to know it, because composer
detection, `panels submit` staging, the agent-specific status manifest and the
agent shown in `panels list` depend on the panel's `agentType`.

Managed agent panels emit `agent.busy`, `agent.ready`, `agent.blocked`,
`agent.unknown` and `agent.idle` events before identification. These reach the
default agents-only workspace watch even without an `agentType`; ordinary shell
panels do not emit them. For example, an Agent Farm variant picker can report
`agent.blocked` before the agent starts. An untyped `panel.exited` is still
filtered by the agents-only watch.

Pane decides a terminal panel's agent in this order, and records the source in
`TerminalPanelState.agentDetection`:

1. **`declared`**: `--agent <id>` together with `--tool-command <command>` on
   `panes create`, `panes adopt` and `panels create`. On the wire this is
   `tool: { command, agentType }`. Here `--agent` means "the agent this command
   runs".
2. **`command`**: the launch command's executable word, through
   `resolveAgentTypeFromCommand` in `main/src/services/agents/agentIdentity.ts`.
3. **`process`**: the PTY's foreground process name, which node-pty reports as
   `pty.process`. Each entry's `executables` map to its agent. Pi sets its
   process title to `pi`, so an npm-installed pi is found here too.
   Claude Code's native installer runs `~/.local/share/claude/versions/<version>`,
   so it reports a bare version such as `2.1.283`. Pane resolves that name to an
   executable path with `ps` (or `/proc/<pid>/exe` on Linux) before trusting it.
   This source is skipped on Windows, WSL and ptyHost terminals, where node-pty
   cannot name the foreground program. A wrapper that stays in the foreground
   (for example a Node process that spawns the agent in its own process group)
   hides the agent from this check.
4. **`screen`**: Claude's closed rule/`❯`/rule composer box, or Codex's
   `OpenAI Codex` header with its `›` prompt, or either agent's folder-trust
   screen: Claude's `Claude Code'll be able to read` with
   `Yes, I trust this folder`, or Codex's `Codex can read, edit, and run files here`
   with `Trust and continue`
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
- restates the panel's current status with the identified agent attached.

Agent-specific composer readiness and a starting message key off the identified
agent, however it was identified. Pre-identification watch events and folder-trust
identification do not establish composer readiness:

- `--wait-ready` (and `panels wait --for ready`) on a launched command matches
  only once the panel has an agent and that agent's own ready rule passes:
  Claude's composer, Codex's configured footer, the existing rules for the
  others. A wrapper's first output byte never counts. A command that shows no
  supported agent times out with `readiness.reason.code: no-agent-detected`;
  one that exits back to Pane's shell fails at once with `command-exited`
  (where the foreground process is known). A plain shell with no launch
  command is ready once it exists.
- Prompts before the agent appears come back as `blocked` with their text:
  Agent Farm's `Trust this repository workspace? [y/N]`, and any `[y/N]` or
  similar last-line question a wrapper or shell asks, even when `--agent` was
  declared. Pane never answers them.
- With `--wait-ready`, runpane owns the starting message: it claims the
  message at create, waits for readiness, stages the text and presses the
  detected agent's submit key separately (Ctrl+Enter for Codex), and verifies
  it like `panels submit`. Without `--wait-ready`, the terminal manager holds
  the message until the agent is identified and idle at its composer, then
  stages and submits it the same way. If no agent appears within 30 seconds
  (a blocking prompt restarts that wait), it records `initialInputError` and
  never types the message into the shell or the wrapper.
- `[TerminalPanelManager] Starting message …` and `[Runpane] Starting message …`
  log lines mark each write and its outcome, with the agent, detection source,
  byte count, submit key and any `PANE_AGENT_SESSION_ID` the wrapper printed.
  They never include the message text.

`launchMode: 'wrapped'` means the command is launched exactly as given.
`resolveCliLaunchCommand` never adds `--session-id`, resume flags or a prompt
argument to it. On restart, Pane runs the wrapper again, and the wrapper handles
its own resume. The exceptions are a panel with an explicit custom command resume
config and a recognized `agent-farm run|agent` command, which relaunch through
their resume template (see
[Resuming custom launchers](SESSIONS.md#resuming-custom-launchers)). For the same
reason, `--resume` is rejected for wrapper commands.

Direct OpenCode launches start without a selector, capture the session id from OpenCode's exit line (`opencode -s <id>`), resume it with `--session`, and use readiness-gated input. OpenCode refuses `--session` for an id it did not create, so Pane never invents one.
Native selector insertion accepts literal direct commands and simple assignment or
`env NAME=value` prefixes, not recognized shell wrappers or `env --` forms. Those
forms fail before spawn; explicitly wrapped launches remain opaque.
Native commands reject both `--continue` and `-c`, and reject OpenCode's
`--prompt` argument because it would replay on every restore. Supply initial
input through Pane (or RunPane's `--prompt`) instead.
Outside Pane Chat and named Sessions, wrapped OpenCode launches run unchanged;
the wrapper owns session selection and resume, just as it does for the other
supported agents. OpenCode Session launches reject wrappers and custom resume.

A new agent works with wrappers once its config entry lists its executable
names (`executables`). Add a screen signature only if the agent's UI has a stable,
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
