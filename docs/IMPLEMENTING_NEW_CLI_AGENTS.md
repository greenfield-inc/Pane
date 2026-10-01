# Implementing New CLI Agents

This document described the removed `AbstractCliManager`/`cliToolRegistry`
architecture and is retired. See [ADDING_NEW_CLI_TOOLS.md](./ADDING_NEW_CLI_TOOLS.md)
for the current integration recipe.

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
   `pty.process`. The names `claude`, `codex`, `cursor-agent` and `opencode` map to agents.
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

Direct OpenCode launches use Pane's durable session id and readiness-gated input.
Wrapped OpenCode launches run unchanged; the wrapper owns session selection and
resume, just as it does for the other supported agents.

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
