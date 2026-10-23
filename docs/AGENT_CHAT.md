# Agent Chat

Agent tabs can use Chat or the agent's native Terminal interface. Right-click
an agent tab (or use Shift+F10, the Context Menu key, or a touch long press) for
**View as Chat** and **View as Terminal**. The React Native companion also has
a Chat/Terminal switch. Chat header actions use the same contextual interaction.

Switching keeps one tab. It reuses the provider conversation where possible;
otherwise it stops the original writer and copies history using the provider's
native fork operation. The fork becomes this tab's active conversation, including
when returning to Terminal. Historical prompts and tools are never replayed as
new work. Successful transfers are quiet; incomplete transfers show a notice.

The last selected interface is one global preference for new agent tabs, saved
across restart. Existing tabs retain their choice. Settings → AI & Agents →
**Default agent interface** can also change the default. **Chat interface**
disables new Chat transitions without terminating existing Chat work.

## Provider connections

Claude Code uses the pinned upstream `@agentclientprotocol/claude-agent-acp`
adapter on the workspace host. Pane installs it automatically in its own data
directory using bundled npm. Setup uses the existing provider login and leaves
global provider configuration alone. Authentication or installation failures are
reported explicitly. Runtime support depends on provider capabilities, rather
than an operating-system or exact CLI-version allowlist.

Direct Claude launches preserve model, effort, permission mode,
`--strict-mcp-config` and `--add-dir`. Native lifecycle hooks establish the
conversation identity and checkpoint. If exact loading is unavailable, the
adapter's native history-copy capability supplies the fallback.

New direct Codex tabs use a dedicated native app-server with authenticated
loopback WebSocket transport. Chat and the native TUI share that owner, allowing
interface switches during a response without restarting the turn. Native policy,
reviewer, sandbox roots and configuration stay in Codex; Pane does not reduce
them to adapter permission presets. The raw connection credential stays on the
host and is passed only to the native TUI, not browser viewers or provider tools.

For older Codex tabs without a verified binding, tab actions offer one-time
identification. Run `/status` yourself when the native composer is ready and
enter its current Session ID and server socket. Pane verifies that the thread
is loaded on that owner and remembers the binding. It never guesses from cwd,
recency or a similarly named history file, and never types into an unknown
native draft or modal. The shared server remains externally owned; Pane owns
only its proxy connection and tab's terminal.

Custom wrappers, unknown launch options, SSH and WSL launch translation require
a verified host launch route. An unavailable route reports its limitation;
remote viewers never start a substitute local provider. A connection or successful
build alone is not evidence of a tested provider round trip on that platform.

## Lifetime and recovery

The host owns the process, exact conversation identity, runtime generation,
pending permissions and transcript projection. Hiding a tab, switching viewers
or disconnecting a remote browser only detaches subscriptions. Stop, close and
archive clean up the active runtime on the owning host.

A handoff preflights the destination, freezes submissions and saves its transition
before changing ownership. A shared Codex owner remains alive across views.
When changing runtimes, the original turn is stopped and tracked process lifetimes
must end before exact loading or a provider-native fork starts. An active turn
does not wait for normal completion merely to switch views.

A returned fork ID is saved before history hydration. If subsequent loading
fails, recovery retains that fork. If a fork response is lost, Pane leaves the
outcome unconfirmed and does not automatically request another copy. Original
provider history is preserved. Recovery never guesses a latest-session ID.

After a host restart, Chat recovery is explicit, including after an app update. Recover in Terminal first to rebuild
the normal workspace launch environment. If a crash occurred before a spawned
process identity or new conversation ID was recorded, inspect the processes and
provider store on that host; Pane does not guess an owner or create a replacement.

Permission cards show the adapter's exact choices. Answers bind to the runtime
generation and request ID; the first accepted answer wins across viewers.
Cancellation withdraws pending requests. A lost send response keeps its operation
ID for **Check delivery** or an explicit **Retry same delivery**. Safe reads can
retry automatically; sends, answers and configuration changes cannot.

## Display and controls

Chat uses assistant-ui’s default thread, message and composer styling. It renders
Markdown, reasoning, tools and edit details. Resource links, embedded resources
and unfamiliar message content have expandable, selectable details; provider protocol metadata is under
the Chat header context menu → Diagnostics on desktop/web. Model, mode and effort
choices come from the host and sit beside Send. Narrow web panels combine them
in one menu trigger; the native app uses a settings sheet.
Configuration controls expose provider-supported choices; native policy details remain available in Diagnostics.
The browser never executes provider tools. Unsupported client filesystem,
terminal and elicitation capabilities are not advertised.

The display cache is limited to 4,000 messages and 16 MiB; larger imports show
a notice that Chat cannot display the entire history. The provider retains the complete conversation.
The desktop/web viewer renders pages of 200 messages; the React Native viewer
uses Legend List virtualization. Both open heavy tool details on demand.
Draft text, pending delivery reconciliation and scroll position survive viewer
remounts during the same application/browser session. The native app also saves
draft text per host, pane and panel on the device. Native image attachments use
ACP image content, with a 5 MiB limit; they do not paste a host filesystem path.
The native app keeps uncertain operations and attachments by saved host profile
and panel through host switches and credential changes, rebinding to the current
connection. The Chat composer clears only the original draft revision after a
confirmed host receipt; edits made while waiting remain. Uncertain deliveries
stay available for reconciliation. Raw terminal input controls are mounted
only for Terminal ownership.

## Automation

`runpane panels submit`, `wait`, `last-message`, `output`, `resume` and workspace
status dispatch to the active runtime. Chat submissions report `sequenceName:
"acp"`, `enter: "none"`, a durable `operationId` and delivery evidence
`"acp-receipt"`. A wait's legacy `screen` field is tagged `source:
"acpTranscript"` when it contains Chat transcript text; it is not a native screen.

Raw `panels input`, `panels screen` and `panels submit-composer` retain literal
terminal semantics and return `CHAT_RAW_TERMINAL_UNSUPPORTED` when Chat owns the
tab. Use semantic submit/read commands or switch to Terminal. Update npm/Python
runpane clients together with Pane to recognize the added response variants.

Commands and ordered generation/revision events use Pane's existing authenticated
daemon transport. Reconnect repairs gaps from a host snapshot. An older host
without these commands remains usable in Terminal and reports Chat unavailable.

## Renderer regression tests

Run `pnpm exec playwright test -c playwright.agent-chat.config.ts` for desktop and
phone viewport checks of bounded history, follow/pause, asynchronous scroll
restoration, permissions, recovery and uncertain delivery reconciliation. These
tests use a local Vite server and fixture host; they do not launch Electron or a
provider. Native viewer state and image validation are covered by
`pnpm --filter native test`. Device interaction and real native/ACP handoffs
require a separate isolated host and configured device or simulator.
