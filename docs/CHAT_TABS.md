# Chat tabs

A chat tab runs a coding agent as a conversation, with no terminal. Pane is an
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) client. Any
agent in the agents config with a `chat` section can run in a chat tab
([Agents](#agents)): Claude and Codex through Pane's bundled ACP adapters,
Cursor and OpenCode as their own CLI in ACP mode. A chat tab stays a chat:
there is no move back into a terminal. A terminal agent tab can move the other
way with **Switch to chat** (below). The *In a terminal* entries of the + menu
open terminal agent tabs, as before.

A fresh install starts with chat tabs on. An existing install keeps the setting
it had, so one that never turned them on stays off until you switch
**Settings → AI & Agents → Chat tabs**. While they are off, the + menu has no chat
entries and new Sessions open their orchestrator in a terminal. Open chat tabs keep working.

## Opening one

- **Desktop**: the + menu lists, under *New tab*, each chat agent installed on
  the Pane's machine, **Agent Farm profile…** and **More agents…** (which opens
  Settings → Agents), then *In a terminal*: the terminal agents and a plain
  Terminal. The menu reads the host's agent catalog again each time it opens,
  so an agent installed meanwhile shows up. The empty Pane screen offers the
  same.
- **Remote PWA** and **phone**: *Add Tool* lists the host's installed chat
  agents and **Agent Farm profile…** first when the host has chat tabs on.
- **Agent Farm profile…** asks for a profile name and optional arguments, one
  `key=value` per line, and opens the chat tab on the Pane's machine exactly as
  `--agent-farm <profile> --arg key=value` does. The name is typed, not picked:
  `agent-farm profiles list` prints no machine-readable list. An unknown profile
  shows Agent Farm's error in the dialog and opens nothing.
- **runpane**: `runpane panels create --pane <id> --chat --agent <id>`, or
  `--agent-farm <profile> [--arg key=value …]` for an Agent Farm profile.
  With `--chat`, `--agent` takes any agent id; the host refuses one it cannot
  run. `--initial-input` is the first prompt, sent once.
- **Sessions**: with chat tabs on, a new Session runs its orchestrator in a
  chat tab for any chat agent, Cursor and OpenCode included (see
  [SESSIONS.md](SESSIONS.md)).

## Agents

Each agent is an entry under `agents.entries` in `contracts/runpane/contract.json`
(schema: `$defs/agent` and `$defs/agentChat` in `contracts/runpane/schema.json`).
Its `chat` section says how its chat starts:

| Agent | Runs as | Full access | Switch to chat |
| --- | --- | --- | --- |
| Claude | bundled `claude-agent-acp` running `claude` | session mode `bypassPermissions` | yes, sure of the conversation |
| Codex | bundled `codex-acp` running `codex` | session mode `agent-full-access` | yes, most recent conversation |
| Cursor | `cursor-agent acp` | launch flag `--force` | no |
| OpenCode | `opencode acp` | Pane answers each approval | yes, most recent conversation |

The host's agent catalog (`chat-tab:agents`,
`main/src/services/chatTabs/agentCatalog.ts`) lists the agents this machine can
open as chats, for every client: label, icon, whether the CLI is installed, its
install page, who gives full access (the agent, or Pane), and whether **Switch
to chat** works and why not. Capabilities (reopens chats, lists past chats,
images) and the version come from each agent's last ACP `initialize` reply,
kept in `chat-agent-capabilities.json` in Pane's data folder, so an agent shows
none until its first chat starts. The desktop + menu, the empty Pane screen,
the PWA + menu and the phone's Add Tool sheet offer the installed ones.

**Settings → Agents** lists every agent in the catalog with what it supports,
its version once known, and an **Install** link for one that is not
installed.

## Agents from the ACP Registry

Below Pane's own agents, **Settings → Agents** lists the
[ACP Registry](https://agentclientprotocol.com) (its URL is the agents
config's `registryUrl`). Pane reads the index when the page opens and
otherwise at most once an hour, and keeps the last copy in
`agent-registry/registry.json` in Pane's data folder.

- **Listed**: agents published as a download for this computer or as an npm
  package. Agents published only for `uvx` are left out (Pane ships no Python
  toolchain), and so are ones a configured agent covers (its `chat.registryIds`).
- **Install** puts the registry's current version in
  `agent-registry/agents/<id>/<version>/`. A download is checked against the
  sha256 the registry publishes and refused when it differs. A download with no
  checksum installs only after you confirm you trust it. An npm package installs
  with your own `npm` and runs with your own Node.js; without them the row says
  **Needs Node.js**. A failed install shows its error on that agent's row only.
- **Updates**: an installed agent moves to the registry's newest version on its
  next launch, with no prompt, and the older version's folder is removed once the
  new one starts and no other tab still runs the old one. When the registry cannot be read or the update fails, the
  installed version runs.
- Installed agents join the + menu after Pane's own agents, marked
  **Full access by Pane** (Pane answers each approval with allow once when full
  access is on). They have no terminal tab, so they have no Switch to chat.
  **Remove** deletes every version.
- Installing or removing an agent is refused for a teammate's Pane: it runs code
  on the owner's machine.

## Switching a terminal tab to chat

**Switch to chat** (right-click a terminal agent tab, or the command palette)
continues the terminal's conversation in a chat tab (D-129, D-184, D-229,
D-282). It works for agents whose config sets `chat.terminalConversationsLoad`
(Claude, Codex and OpenCode). It asks with one plain confirmation and never
sends anything to your agent. The menu of a tab running any agent in the
catalog always shows it (D-337): with chat tabs off it is greyed out with
**Turn on chat tabs** below it; for an agent whose chat can't load its
terminal's conversations (Cursor) it is greyed out with that reason; and a chat
tab shows it greyed out as already a chat. The command palette offers it only
when the switch can run.

Right-click a Session in the sidebar (or on All machines, where it runs on the
Session's own machine) and choose **Switch to chat…** to switch every terminal
agent tab in it: the orchestrator, and the agent tabs of each Pane in it (all of
a Pane's tabs when the whole Pane is in the Session, otherwise only the tabs
added to it). A dialog
first lists the tabs that will switch and the ones it will skip, with why (busy
mid-turn, a tab Pane isn't sure of the conversation for, which includes every
terminal of an agent other than Claude, not an agent, a launch chat can't run). A Session switch opens
only conversations Pane is sure of; switch an unsure tab from its own menu to
get the most recent one and **Pick another**. A Pane's terminal dock is
not a tab and isn't listed. Pane then switches them one at a time the same way
as one tab, so a tab that fails is put back the way one tab's switch puts it
back and the others carry on,
and the dialog ends with a summary such as "4 switched, 1 skipped: busy". Each
tab is checked again just before it switches; one that wasn't on the confirmed
list (busy then, or opened since) is left as it is. The item is always in the
Session menu (D-337): it shows a spinner and "Checking…" while the Session's
machine looks, then greys out with why when nothing can switch ("Nothing to
switch: 2 busy, 1 no saved conversation", or "Chat tabs are off on build-box"). When chat
tabs are off on this window's own host, **Turn on chat tabs** sits below it;
it turns them on and closes the menu, and the menu checks again each time it
opens.

**Which conversation opens.** Only Claude's terminal reports its conversation
(`terminal.reportsConversation` in its config). Pane learns it from Claude
Code's `SessionStart` hook, which fires on start, `/resume`, `/clear` and
compact (D-269). Pane adds the hook to plain `claude` tabs through the tab's
`--settings` file, and Agent Farm ships it in the plugin it compiles for every
Claude it launches. The hook runs `runpane panels conversation --hook`, which
records the conversation on the tab and as the one its next restart resumes.
Pane never asks the running Claude.

- **Sure**: the hook reported since the terminal's current launch started. The
  chat loads that conversation with ACP `session/load`, with its history and no
  banner. If it has no messages yet, the chat starts new with a "Started a new
  conversation" note instead.
- **Not sure**: no report from this launch (a terminal started before the update
  or by an older Agent Farm, WSL and SSH tabs) and every terminal of another
  agent (Codex, OpenCode). The chat
  lists the folder's conversations (ACP `session/list`), leaves out any open in
  another Pane tab on this machine, and opens the newest, with the banner
  "Opened the most recent conversation here" and **Pick another**. The terminal
  has just stopped, so its own conversation counts, and it is usually the one.
  With none left the chat starts new with a note; if listing fails (for example
  Codex signed out), or every one of the newest 2,000 is open elsewhere, it
  starts new and says why. Two chats opened at once never get the same one.

Nothing is touched when a turn is in progress (Pane asks you to wait or stop
it) or when the launch can't be kept: the chat gets the plain agent, whose
terminal full-access flags become the chat's full access, or the Agent Farm
profile and its args (a Session's own saved launch for its orchestrator). The
agent's other default terminal flags (`terminal.args`, such as Cursor's
`--trust`) are accepted and dropped. A `--model` flag becomes the chat's model,
and Claude in a Session's Pane keeps its read-only Session folder access
(`--settings` there, `claudeCode.options.settings` here). Any other flag or a
wrapper command is refused by name.

Otherwise Pane stops the terminal agent, opens the chat tab, then closes the
terminal tab. The chat takes the terminal's exact place in the tab order and is
selected. A Session's orchestrator becomes its chat tab.

If the chat fails after the terminal stopped, the dialog says what happened,
with **Try again** (the reason is also in Pane's log, as `[ChatTabs]`), and the
chat tab is removed. When Pane was sure, the terminal restarts on that
conversation ("The chat couldn't open it … The terminal is back on the same
conversation"); if that restart fails too, it says the terminal is stopped and
the conversation is saved. When Pane wasn't sure, or the conversation had no
messages, the terminal stays stopped ("The chat couldn't start"), since a
restart could open the wrong conversation or start an empty one. A terminal
restarted in place redraws at once. In the rare case that the chat has the
conversation but the Session could not move to it, or the terminal tab could not
be closed, the dialog says so and both tabs stay, since removing either could
lose the Session's tab. Pane rebuilds no telemetry for the switch.

A terminal Codex that runs through Codex's shared background service
(`codex app-server daemon`) stays that thread's writer after the terminal stops,
so loading it in chat fails with "in use by another Codex client".

## Continuing a past conversation (/resume)

Any chat tab can continue another conversation from its folder. Type `/resume`
(the composer menu lists it as Pane's own, since Claude Code hides its `/resume`
from chat and Codex has none) or press **Pick another** on the banner. The
picker lists the folder's conversations newest first, with a filter. The tab's
own is marked "open here"; one open in another Pane tab shows "Open in tab …"
and can't be picked, so two processes never write one conversation. Picking one
reloads the tab on it with its history; the tab keeps its Session. Picking is
refused while the agent is in the middle of a turn, and while messages wait in
the queue, since they were written for the current conversation (remove them or
let them send first). Pane lists up to the newest 2,000 conversations of a
folder; past that the picker says older ones aren't shown. A conversation running
outside Pane (a plain shell `claude`) can't be detected and is listed like any
other. The picker works in the desktop chat tab, the Autopilot view and the
remote web app.

## Where the agent runs, and sign-in

The agent runs on the tab's host: this computer for a local Pane, the other
machine for a Pane on a connected machine. Clients (desktop, PWA, phone) only
show the conversation and send messages.

A chat tab always runs the person's installed, unmodified CLI, found on the
same PATH terminal agent tabs use (`main/src/services/chatTabs/launch.ts`). A
bundled adapter gets it through the variable its config names
(`chat.adapter.executableEnv`: `CLAUDE_CODE_EXECUTABLE` for Claude, `CODEX_PATH`
for Codex). An agent with `chat.args` runs as its own CLI with those arguments
(`cursor-agent acp`, `opencode acp`). Pane never uses a bundled copy of an
agent CLI, never reads, stores or relays an agent's login, and never copies one
between machines.

- **Not signed in**: the tab stops and says so, with **Sign in in
  Terminal**, which opens a terminal tab on that machine running the agent's
  advertised terminal sign-in (an agent running as its own CLI), or its
  executable with the config's `signIn` arguments (`claude auth login`,
  `codex login`). Press **Retry** after signing in. The tab never retries alone.
- **Not installed**: the tab says so with the command that installs it.
- **API key (optional)**: Settings → AI & Agents → *Chat tab sign-in* keeps one
  key per agent whose config names `chat.apiKeyEnv`, in the OS secure store on
  that machine (Electron `safeStorage`, `chat-tab-keys.json`, a map by agent
  id), and passes it only as those env variables (Claude `ANTHROPIC_API_KEY`;
  Codex `OPENAI_API_KEY` and `CODEX_API_KEY`; Cursor `CURSOR_API_KEY`). OpenCode
  takes none. A key is never synced or sent to clients.
  The key is the owner's: a teammate (another login on the tailnet, when the
  host is set to "Everyone on tailnet") cannot save or remove it, and a chat
  tab a teammate opens starts without it or the project's secret variables,
  including after the owner switches that teammate's terminal to chat.
  A teammate cannot run Sign in for a chat tab either. Saving a key needs Chat
  tabs on; removing one always works.

Chat tabs don't run in WSL projects or on SSH hosts.

## Adapters and versions

The adapters ship inside Pane as exact dependencies in `package.json`:
`claude-agent-acp` 0.100.0 and `codex-acp` 2.5.0. Nothing is downloaded.
`scripts/verify-chat-adapters.js` fails a packaged build unless each bundled
adapter starts and answers ACP `initialize`. A build missing its
adapter says to reinstall Pane.

Before a chat tab starts, `checkAgentCli`
(`main/src/services/agentChat/adapterSetup.ts`) checks that the installed CLI
it will run, in the tab's folder and environment, is at least the agent's
`chat.minimumVersion`: Claude Code 2.1.316, Codex 0.165.0, Cursor 2026.10.22,
OpenCode 1.18.14. An older one stops the tab with the command that updates it.
Change an adapter pin only with its agent's `chat.minimumVersion`, and after
running the chat tab suites against it.

## Full access

Full access lets the agent act without asking (D-16). The agents config says
how each agent gets it:

- **A session mode** (`chat.fullAccess.mode`: Claude `bypassPermissions`,
  Codex `agent-full-access`): the agent's own permission mode chip sets it.
- **A launch flag** (`chat.fullAccess.args`: Cursor, whose terminal
  `fullAccessArgs` are `--force`): Pane adds a **Full access** On/Off setting
  to the composer's settings menu. Switching it restarts the agent with or
  without the flag, on the same conversation.
- **Neither** (OpenCode): the same **Full access** setting. While it is on,
  Pane answers each approval request with the agent's allow-once option, never
  allow-always, and marks the step "Approved by Pane" (the mark lasts while
  the tab runs; a reopened conversation's history comes from the agent and has
  none). Switching it takes effect at once.

Full access can't change during a turn. While Pane's Full access is on, the
composer marks it in amber like a mode that never asks.

## What the chat shows

- Replies stream as markdown; thinking is collapsed.
- The agent's steps are grouped by kind: *Explored 2 files, 1 search*,
  *Edit file +18 −4* with **View diff** (which opens Pane's diff view; a diff
  never renders in the thread by itself; the PWA and the phone bring the Pane's
  Diff tab forward, which shows the branch's changes read-only), *Run* with the command's output
  streaming in its own row, *Ran 9 commands*.
- To-do lists from the agent's plan updates.
- **Approvals** dock above the composer with exactly the choices the agent
  sent; keys 1 to 9 answer while the composer is empty. Typing a message
  instead sends it and, once Pane has it, declines the request. ExitPlanMode shows the
  plan itself. A step Pane approved under its own Full access is marked
  "Approved by Pane" ([Full access](#full-access)).
- **Questions** (ACP form elicitation, such as Claude's AskUserQuestion) dock
  as a form. Pane declares `elicitation.form`; without it Claude turns
  AskUserQuestion off. Agents use it only for a quick question in this chat;
  anything else goes to an approval card
  ([PANE_NOTIFY.md](PANE_NOTIFY.md#what-an-agent-can-send), "Which card").
- The composer is the input over one row of controls: attach image, the
  permission mode chip, then one menu showing model and effort together
  ("Opus 5.5 · Medium"; a trailing "(recommended)" and an effort of "Default"
  are left off the button, never from the menu). A mode that never asks
  (Bypass, Codex's Full access) shows its chip in amber, as does any mode chip
  while Pane's own Full access setting is on; an agent with no mode chip shows
  a small shield instead. The row never overflows a
  narrow column: the model label truncates and the mode chip drops to its icon
  first, while attach and send keep their size. In a window dragged very
  narrow the row drops the model button, then attach, and keeps send. That menu also holds every other setting the agent
  offers (such as Claude's Fast mode, Ultracode and Agent), each under its own
  name, and Pane's **Full access** for an agent without a full-access mode. Pane places a setting by its ACP category (`mode`, `model`,
  `thought_level`), or by its id when the agent sends none. At phone width
  (the phone app, and the PWA when the composer is under 480px) the row is
  sparer: **+**, then the model as plain text with its effort muted ("Opus 5.5
  Medium"), then send. The permission mode moves into that button's sheet as
  **Permissions**, below Model, Effort and the other settings; each choice shows
  a check and On/Off settings are switches. A mode that never asks (Bypass), or
  Pane's Full access when on, leaves a small shield on the row. The `/` menu lists
  the agent's own commands and skills, plus Pane's own **/clear**; **Stop** (or Esc in the composer) cancels the turn.
- **Status bar** (D-222, D-253, D-267, D-276): one muted line just above the composer,
  items split by dots, each opening what it names:
  - **Context left** ("Ctx 41%", amber at 20% or less) opens the tokens used,
    a meter and **Clear conversation**; it is absent when the adapter reports no
    usage;
  - **Agents working** ("3 working"), in a Session orchestrator's chat and in
    Autopilot's: how many of the Session's agents are working right now (for
    Autopilot, across every Session it walks), counted from the Session
    overview: one per tab whose agent is working, so a Pane with an implementer
    and a reviewer both working counts two. Tabs waiting, idle or finished
    don't count, and the item is hidden when none is working. A change re-reads
    only the Session it names. It opens a list of each agent with its tab; a
    row opens that tab (the PWA opens its Pane);
  - **Pull request** ("#1272 · Open", the chat's Pane's PR) opens it on GitHub;
    the PWA reads it from the host's git status;
  - **Background tasks** ("2 tasks") lists them, with Stop where the adapter
    allows it;
  - **Queued messages** ("2 queued") moves focus to the queue.

  Items with nothing to say stay out. **…** picks which items show; the choice
  is remembered on this device (`pane-chat-status-items:v1` in local storage),
  and **Reset to default** brings all five back. While a turn runs the bar ends
  with the send-now keys. At phone width it is compact (the percentage and PR
  number alone) and scrolls sideways instead of wrapping. The phone app has no
  status bar yet.
- **Enter goes to the chat** (D-328): with a chat tab on screen and focus on
  no control (the page, a split, a scroll surface such as the commit history),
  Enter moves focus into its message box. Opening a Pane or Session with Enter
  from the sidebar, or pressing Enter on a chat's tab, lands there too, even
  while the chat is still loading. With splits, Enter stays in its own split:
  it goes to the focused split's chat, and a chat's tab opens into that chat,
  never into another split's. Enter in a field, terminal, button, menu, picker
  or dialog keeps its own meaning.
- **Queue and Send now** (D-211): a message sent while the agent works (Enter)
  waits in the queue, listed in the order it will be sent. Each queued message
  can be edited (its images are kept), removed, or sent now. **Send now**, or
  Cmd/Ctrl+Enter in the composer, puts the message first and interrupts the
  running turn (including one blocked on an approval or question), so it is
  sent as soon as the turn stops (`chat-tab:send` with `now`, `chat-tab:send-now`,
  `chat-tab:edit-queued`).
- **/clear** (or **Clear** above the thread) ends the agent and starts a fresh
  conversation in the same tab, with the same agent, launch and settings
  (`chat-tab:clear`). It asks first while a turn runs; a turn cut off this way is
  marked failed. Queued messages are kept and go to the new conversation, which
  starts with a "Cleared · 2:04 PM" divider. A stopped tab refuses it, and
  Autopilot's chat does not offer it (its conversation holds what Start told it).
- **Context and background work**: the view carries the adapter's last
  `usage_update` (`context: { used, size }`, from any agent that sends it) and the
  background tasks it runs (`tasks`, Claude's background shells and subagents;
  `chat-tab:stop-task` stops one). Usage is kept in memory, so a reopened chat has
  none until its next turn, and the status bar shows nothing rather than a guess.
- **Copying**: message text can be selected and copied like any page. Each
  message and each finished response has a copy button (on hover with a mouse,
  always on touch) that copies what was written, as Markdown, without the
  agent's activity. **Copy conversation** above the thread copies the loaded
  conversation under **You:** and the agent's name, with each tool step as one
  short line and no raw output. Code blocks have their own copy button. On the
  phone app, each message has a copy action, and a long press on a reply copies
  it.
- **Attachments** (desktop and PWA): drop photos and files anywhere on the chat,
  paste them into the composer, or pick them with **+**. An image the agent
  takes (PNG, JPEG, WebP or GIF up to 5 MB) is sent as an image. Any other file,
  up to 10 MB, is copied to the Pane's folder on the chat's machine under its own
  name (in a folder of its own, so two files with one name never collide), the same
  way a terminal tab's upload works (`terminal:paste-file`, so a remote host
  receives it too), and its path is sent with the message. Each attachment is a
  chip that can be removed before sending, and sending waits until every file
  has finished copying. Every refusal says why, and nothing is attached for it.
  The phone app keeps its **+** photo picker.
- The composer does not show the machine: the window's machine picker does, and
  an approval from a remote machine names it.

A chat shows the agent's text and pictures; what it did in between stays out of
the way (D-192). While a turn runs, one quiet line says what it's doing now
("Running pnpm test", "Thinking"). When it ends, its steps, thinking, to-do lists
and notices fold into one row, "Worked for 27s", that opens to them.

The latest turn says when it finished (D-202): "Worked for 27s · 2:04 PM", or
"2:04 PM" alone when it did nothing but answer. An older time reads "Yesterday
4:12 PM" or "Nov 3, 4:12 PM", in the person's locale. Every other message shows
its time on hover; on the phone, a long press shows it. A conversation reopened
after a restart has no times for its earlier turns.

The conversation stays in the order things happened (D-193). Claude can start a
turn by itself, for example when a background command finishes. Pane sees that
through the adapter's `asyncTasks` capability: the tab shows as working, the turn
gets its own row, and a message sent meanwhile waits in the queue until the turn
ends, like one sent during any other turn. Stop ends it.

In a Session orchestrator's chat, a worker Pane shows up as one line with
**Open** when it finished or failed during the latest turn, once that turn has
ended (D-201, narrowed by D-223), for example "approvals-global finished ·
**Open**". A worker's question reaches the person as an approval the
orchestrator relays (D-220), never as a line here. Other workers stay out of
the chat; the sidebar lists every Pane. This comes from Pane's own Session state
(its Panes, their agent states and `runpane report`s), never from what the agent
wrote.

Approvals and questions are also asked in Pane's Approvals and on the phone (see
[PANE_NOTIFY.md](PANE_NOTIFY.md)), a question form one field at a time. The
first answer wins everywhere. In the chat, a form that asks several questions
(Claude's AskUserQuestion with more than one, or any form with several fields)
takes them one at a time (D-230): "1 of 2", each question with its options and
its Other box, Next and Back, and on the last one a review of the picks beside
**Answer**. Every field is a question of its own, except a choice's optional
Other box (keyed after the choice, such as `question_0_custom`, or titled
"Other"), which stays with it. Number keys pick an option and Enter goes on,
with focus moving to each new question; **Skip** passes over one question, and
skipping every one declines the form. A form with one question has no steps.

## Restart and resume

A chat tab saves its agent, its launch (plain agent with an optional session
mode, or an Agent Farm profile and its args), its working folder and the ACP
session ID. It saves no env and no secret: env is rebuilt at every start, and an
Agent Farm profile is printed again.

After Pane restarts, a chat tab starts again when you open it (or on
`runpane panels resume` / `resume-many`), loads its conversation (the adapter
replays the history) and shows it. A turn that was running when Pane closed is
marked *Stopped when Pane closed*; a message sent then continues the same
conversation. If the agent exits, the tab shows why with **Restart**, which
loads the same conversation.

## Cost

- No process polling: Pane learns about the adapter's exit from its own events,
  and stops the adapter's whole process group when the tab closes.
- No cap stops a conversation: the newest messages stay in memory (up to 1,000
  or 24 MiB per tab) and older ones go to a per-tab file under `chat-tabs/` in
  Pane's data folder, rebuilt at every start. Viewers keep a window of at most
  about 700 messages: **Earlier messages** pages older ones in
  (`chat-tab:history`) and drops the newest, **Newer messages** pages back
  down, and the jump-to-latest arrow returns to the live end.
- A queued message keeps only a preview in the tab's saved state; its full text
  and images wait in a file beside it until they are sent.
- A tool step's update sends only the fields that changed; command output is sent
  as appends.

## runpane on chat tabs

`panels submit` sends an ACP prompt and returns an `acp-receipt` (queued while
the agent works). `panels wait` is ready when a turn ended and nothing is queued,
and returns at once as blocked while an approval or question waits. A text
wait (`--for text`) searches only what the agent writes after the wait starts,
plus a reply still streaming then, never the person's prompts. `screen`
and `output` read the transcript (`source: acpTranscript`), `last-message` the
newest reply, `report` is kept in the tab's state, and `resume` restarts the
agent and loads the conversation. `panels input` and `submit-composer` fail with
`CHAT_TAB_NO_TERMINAL`: a chat tab has no terminal. The agent gets the same
env as a terminal agent tab: `PANE_*`, so `runpane report` and `notify` work from
inside it, the project's environment variables, and `GIT_CEILING_DIRECTORIES`
for a Session orchestrator.

## Agent Farm profiles

For `--agent-farm`, Pane runs `agent-farm run <profile> --print-acp --acp-adapter
<bundled adapter> [--arg key=value …]` at every start, spawns the printed `argv`
with the printed `env` added, sends the printed `session` on `session/new` and
`session/load`, and selects the printed `mode` with `session/set_mode` after each.
Agent Farm runs the adapter with plain Node, which can't read inside `app.asar`,
so a packaged Pane passes a small launcher from `agent-adapters/` in its data
folder that starts the bundled adapter with Pane's Electron.
A profile's harness must be an agent Pane runs through a bundled adapter
(Claude or Codex).
The profile's model, effort, instructions with LAUNCH CONTEXT, skills,
subagents, MCP servers and telemetry come with it. The contract is Agent Farm's
CONFIGURATION.md, *ACP sessions*.

## Older clients

Phone apps released before chat tabs would crash on a tab kind they don't know,
and send no version. Clients pass what they can show: `{ chatTabs: true,
chatAgents: true }` from this desktop, the PWA and the current phone app. A
client without `chatTabs` shows no chat tab; one without `chatAgents` shows
only chat tabs of agents whose config sets `chat.legacyClients` (Claude and
Codex) (`clientShowsChatTab` in `main/src/ipc/panels.ts`). For a chat tab the
client can't show, `panels:list` leaves it out, a Session the client creates
starts its orchestrator in a terminal, and `orchestration-sessions:get` of a
Session whose orchestrator is that chat tab fails with
`CHAT_TAB_CLIENT_OUTDATED`, which says to update Pane on the phone (D-100).

## Code

| Part | Where |
| --- | --- |
| Agents config (generated by `node scripts/generate-runpane-contract.js`) | `contracts/runpane/contract.json` `agents`, `shared/types/generatedAgents.ts`, read through `shared/agents.ts` |
| ACP Registry install (`chat-tab:registry`, `install-agent`, `remove-agent`) | `main/src/services/agentRegistry/`, `frontend/src/stores/agentRegistryStore.ts` |
| Agent catalog (`chat-tab:agents`) | `main/src/services/chatTabs/agentCatalog.ts`, `frontend/src/stores/chatAgentsStore.ts`, `frontend/src/components/settings/categories/AgentsSettings.tsx` |
| Host runtime, transcript, launcher, Agent Farm profiles, Notify bridge, Switch to chat | `main/src/services/chatTabs/` |
| Commands (`chat-tab:*`) | `main/src/ipc/chatTabs.ts` |
| runpane | `main/src/ipc/runpaneChatTabs.ts`, `main/src/ipc/runpane.ts` |
| Shared types, presentation, decoders | `shared/types/chatTab.ts`, `shared/chatTabPresentation.ts`, `shared/chatTabPermissions.ts`, `shared/chatTabQuestions.ts`, `shared/types/chatTabDecoders.ts` |
| Viewer (window, paging, catch-up), shared by every client | `shared/chatTabViewer.ts` |
| Desktop and PWA UI | `frontend/src/components/chatTab/`, `frontend/src/remote/components/RemoteChatTab.tsx` |
| Phone UI | `native/src/features/chatTab/` |

## Testing

Tests never touch a real agent account. `main/src/services/chatTabs/testing/scriptedAgent.mjs`
is a scripted ACP agent (each prompt's first word picks a behaviour: `permission`,
`question`, `slow`, `crash`, `steps 6`, `edit`, `plan`, …), and `fakeAgentFarm.mjs`
prints a `--print-acp` launch for it. An unpackaged Pane started with
`PANE_CHAT_TEST_AGENT=<path to scriptedAgent.mjs>` runs it in every chat tab;
`tests/chat-tabs.spec.ts` uses that for journeys J1 and J5: run it with
`pnpm build:main && pnpm test:chat-tabs` (CI runs it in Functional Smoke (Electron)).
