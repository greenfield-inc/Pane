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
  the Pane's machine, **Profile…** and **More agents…** (which opens
  Settings → Agents), then *In a terminal*: the terminal agents and a plain
  Terminal. The menu reads the host's agent catalog again each time it opens,
  so an agent installed meanwhile shows up. The empty Pane screen offers the
  same.
- **Remote PWA** and **phone**: *Add Tool* lists the host's installed chat
  agents and **Profile…** first when the host has chat tabs on.
- **Profile…** asks for an Agent Farm profile name and optional arguments, one
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
config's `registryUrl`). Pane reads the index at most once an hour, when the
page opens or an installed agent launches; **Refresh** on the page reads it now.
It keeps the last copy in `agent-registry/registry.json` in Pane's data folder.
With no copy and no connection, installed agents still show, with Remove.

- **Listed**: agents published as a download for this computer or as an npm
  package. Agents published only for `uvx` are left out (Pane ships no Python
  toolchain), and so are ones a configured agent covers (its `chat.registryIds`).
- **Install** puts the registry's current version in
  `agent-registry/agents/<id>/<version>/`. A download is checked against the
  sha256 the registry publishes and refused when it differs. A download with no
  checksum installs only after you confirm you trust it; later versions of that
  agent then install without asking again. An npm package installs
  with your own `npm` and runs with your own Node.js; without them the row says
  **Needs Node.js**. A failed install shows its error on that agent's row only.
- **Updates**: an installed agent moves to the registry's newest version on its
  next launch, with no prompt, and the older version's folder is removed once the
  new one starts and no other tab still runs the old one. When the registry cannot be read or the update fails, the
  installed version runs.
- Installed agents join the + menu after Pane's own agents, marked
  **Full access by Pane** (Pane answers each approval with allow once when full
  access is on). They have no terminal tab, so they have no Switch to chat.
  **Remove** deletes every version; it is refused while a chat tab runs the
  agent. An installed agent the registry stops offering stays in the list,
  marked **No longer listed**, so it can still be removed.
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
Claude it launches. The hook runs `runpane panels conversation --hook` (Agent
Farm since #220 runs `runpane session-start`, the same thing), which records the conversation on the tab and as the one its next restart resumes.
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

## Files and skills in a message

Type `@`, `$` or `/` at the start of a word. One menu opens above the message box,
on desktop, the web app and the phone, and a pick goes into the text.

| Sign | Lists | A pick writes |
| --- | --- | --- |
| `@` | files and folders of the tab's folder; with nothing typed, the files this Pane changed, then top-level folders and files | `@path`, or `@"path"` when it has a space; a folder ends with `/` |
| `$` | the agent's skills | `$name` |
| `/` first in the message | the agent's commands and skills, plus Pane's own **/clear** and **/resume** | `/name` for a command, `$name` for a skill |
| `/` later in the message | skills whose name it begins | `$name` |

- **Keys**: the first row is chosen. ↑ and ↓ wrap, Enter or Tab picks, Escape closes
  the menu for that word. Under a `/` later in the message no row is chosen at first:
  Enter sends, Tab takes the top skill, ↓ or ↑ chooses a row and Enter then picks it. On the phone a tap picks.
- **What opens nothing**: code (backticks and fences), pasted text, money (`$5`, `$10k`),
  an email address, a word with a second slash. A later `/` also needs a letter next and no dot.
- A picked file is highlighted in the box and stays plain text. In a sent message,
  files and folders (an `@` word with a slash, a file extension or quotes) and skills
  are marked. A click on a file opens it under the tab's folder.
- **Which files** (`chat-tab:files`): the host finds the folder from the tab, never from
  the client, and only lists one inside the tab's Pane. In a git worktree git says what is
  there, so gitignored files stay out. Nested repositories, links that leave the folder and
  names a reference could not hold (a double quote, a line break) stay out too. A Session's
  chat lists its Session folder without hidden names. Autopilot's chat lists no files.
  Files come from the computer that runs the tab. Read-only and glasses devices cannot call it.
- **Which skills**: Claude and Codex say which of their entries are skills
  (`chat.skills` in the agents config). For other agents `$` opens nothing and `/` lists
  everything, at the start only.
- **What the agent gets**: Codex reads `$name` in the text. Claude runs one skill per message,
  as the last part of it, so Pane sends the message whole with its skills as `/name`, then the last
  `$name` outside code and the text after it as a part of its own, after any images. Claude runs
  that one; earlier skills stay named in the text. A message that starts with a command goes as typed. The chat shows
  the message as typed, also after a restart: Pane keeps its text beside the conversation, for any tab that opens it, since
  Claude's own history holds only the skill's part.

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
  Pane's Full access when on, leaves a small shield on the row. **Stop** (or Esc in the composer) cancels the turn.
  What `@`, `$` and `/` open is under [Files and skills in a message](#files-and-skills-in-a-message).
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
  Cmd/Ctrl+Enter in the composer, puts the message first and gives it to the
  agent at once. Claude and Codex take it inside the running turn (ACP's
  `_session/steering`), where it shows as part of that turn; the turn, its
  subagents and its background tasks keep
  running. An approval or question the turn waits on stays open: Claude holds
  the message until it is answered; when Codex reads it then is not known. A
  steer the agent refuses leaves the message queued with a notice. An agent
  without steering, and a turn Claude started on its own, are stopped first and
  the message is sent next. The view's `sendNowSteers` says which applies, and
  Send now's tooltip says it (`chat-tab:send` with `now`, `chat-tab:send-now`,
  `chat-tab:edit-queued`). Only Stop stops a steered turn.
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
  agent's activity. **Copy conversation** above the thread copies the whole
  conversation, including messages scrolled out of the window, under **You:**
  and the agent's name, with each tool step as one short line and no raw output. Code blocks have their own copy button. On the
  phone app, each message has a copy action, and a long press on a reply copies
  it.
- **Attachments** (desktop and PWA): drop photos and files anywhere on the chat,
  paste them into the composer, or pick them with **+**. An image the agent
  takes (PNG, JPEG, WebP or GIF up to 5 MB, the most Anthropic's API takes as
  one image) is sent as an image. Any other file, of any size, is copied to the
  Pane's folder on the chat's machine under its own name (in a folder of its own,
  so two files with one name never collide), the same resumable chunked upload a
  terminal tab and the phone use (`terminal:upload-start`, so a remote host
  receives it too), and its path is sent with the message. Each attachment is a
  chip that shows how far its copy has got (and the time left when it is slow),
  can be removed before sending (which stops its copy), and sending waits until
  every file has finished copying. Leaving the chat keeps a copy running, and the
  draft's chip picks it up again when you come back (or takes the path of a copy
  that finished meanwhile). Closing the chat tab stops its copies. The host refuses a file only when it would leave less free space than
  Machine health's critical level. Every refusal says why, and nothing is attached for it.
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
after a restart keeps the times of its last 200 turns; older turns show none.

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
loads the same conversation. An agent saves a conversation with its first
message, so a tab that never had one starts a new conversation instead.

Auto-pause (Settings > Pause) stops the agent of a chat tab idle for
`chatIdleReleaseMinutes` (30 by default), which frees its memory. It skips the
Pane on screen and a tab that is working, holds a queued message or waits on the
person. The paused tab keeps showing its conversation and controls; opening it,
sending it a message or using its model, mode or `/resume` controls resumes the
agent in the same conversation.

## Cost

- No process polling: Pane learns about the adapter's exit from its own events,
  and stops the adapter's whole process group when the tab closes.
- No cap stops a conversation: the newest messages stay in memory (up to 1,000
  or 24 MiB per tab) and older ones go to a per-tab file under `chat-tabs/` in
  Pane's data folder, rebuilt at every start. Viewers keep a window of at most
  about 700 messages: **Earlier messages** pages older ones in
  (`chat-tab:history`) and drops the newest, **Newer messages** pages back
  down, and the jump-to-latest arrow returns to the live end.
- Only the chat tab on screen renders. A hidden tab is unmounted; the five
  hidden most recently keep their newest 200 messages, and the rest hold no
  transcript. Showing a tab paints the messages it kept, then reads the newest
  window from the host once.
- A streaming reply redraws at most once per stream frame (`STREAM_FRAME_MS` in
  `shared/constants/streamCadence.ts`, also the terminals' output interval when
  no one is typing), and its markdown is parsed block by block, so an update
  re-parses only the block being written. A reply with link definitions,
  footnotes or a raw HTML block that can span blank lines is parsed whole, and
  so is a reply shown after its turn ended, which keeps opening a long chat
  fast.
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
<bundled adapter> [--arg key=value …] [--parent <token>]` at every start, spawns the printed `argv`
with the printed `env` added, sends the printed `session` on `session/new` and
`session/load`, and selects the printed `mode` with `session/set_mode` after each.
Agent Farm runs the adapter with plain Node, which can't read inside `app.asar`,
so a packaged Pane passes a small launcher from `agent-adapters/` in its data
folder that starts the bundled adapter with Pane's Electron.
A profile's harness must be an agent Pane runs through a bundled adapter
(Claude or Codex).

A linked agent (an entry in a profile's *Launch links*) starts the same way, by
its name, with `panels create --agent-farm <name> --parent <token>`, the parent
token its parent's links print; Agent Farm checks the link and records the
parent, and refuses a name the parent doesn't list. With Profiles on, a terminal
launch command copied from those links (`<PANE_DIR>/bin/agent-farm run <name>
--config-root <PANE_DIR>/agent-farm --parent <token>`) also runs as a chat tab
when a Session or Switch to chat converts it: Pane reads the shim's path,
`--parent`, and a `--config-root` naming its own root. Any other path to an
`agent-farm` is the person's own executable and keeps its terminal. `--parent`
needs Profiles on (`CHAT_PROFILE_PARENT_OFF` otherwise), and a linked agent's
chat tab started while Profiles was on doesn't start again once it is off: it
stops with `CHAT_PROFILE_PARENT_OFF` instead of running without its parent. While Profiles is on, chat tabs run
Agent Farm through the shim's launcher ([RUNPANE_BUNDLED_CLI.md](RUNPANE_BUNDLED_CLI.md)), so the commands Agent Farm writes
into a profile's Launch links name `<PANE_DIR>/bin/agent-farm`, which runs in
any terminal, rather than Pane's Electron binary.
The profile's model, effort, instructions with LAUNCH CONTEXT, skills,
subagents, MCP servers and telemetry come with it. The contract is Agent Farm's
CONFIGURATION.md, *ACP sessions*.

### Profiles switch

Settings › Advanced › Experimental › *Profiles* (`sessionProfilesEnabled` in
`<PANE_DIR>/config.json`, off by default, T-63) decides which `agent-farm` runs
and who decides telemetry. Main reads it only through
`main/src/services/agentFarm/profilesFeature.ts` (`profilesEnabled`,
`profilesOn`), and the renderer through `isProfilesEnabled` in
`frontend/src/stores/configStore.ts`; later Profiles work gates itself with the
same helpers. The removed Profiles engine's `profilesEnabled` key, still saved
on some computers, is never read, so it cannot turn this on. A change applies
without a restart: to new commands in Pane's terminals, new chat launches and
new Session moves.

Which `agent-farm` runs with Profiles **off**, as before T-63: the person's own
when one is on PATH, with their own config root. Without one, chat launches
run the bundled copy described below. Pane puts no `agent-farm` in its
terminals, and Session move's checks run `agent-farm` from PATH.

With Profiles **on**: always the one Pane ships (`@greenfieldco/agent-farm`,
pinned in `package.json` and `main/package.json`), with its Electron as Node and
`--config-root <PANE_DIR>/agent-farm`. An agent-farm the person installed
themselves is not used, and Pane never reads or writes their
`~/.config/agent-farm`. Chat launches and Session move's checks run it directly
(`paneAgentFarmProcess` in `main/src/services/agentFarm/bundledAgentFarm.ts`).
Pane's terminals get it as `agent-farm` from `<PANE_DIR>/bin` (see
[RUNPANE_BUNDLED_CLI.md](RUNPANE_BUNDLED_CLI.md)), which adds the config root
before any `--` unless the command names its own. The bare `agent-farm` menu,
`init` and `doctor` only ever use `~/.config/agent-farm`, so the shim refuses them
and says why. Turning Profiles off removes that shim.

### The bundled copy and its telemetry

At each start, whatever the switch (`installBundledAgentFarm`, called from
`main/src/daemon/bootstrap.ts` without waiting), Pane installs one plugin from
the bundled package, greenfield, into `<PANE_DIR>/agent-farm`, when the package's
version or plugin files differ from what `<PANE_DIR>/agent-farm/pane-manifest.json`
records; an unchanged bundle installs nothing and the log says so. Plugins older Pane builds
installed there (dcouple and bigbrain) are removed at each start with Agent
Farm's `plugin uninstall`, which deletes only files unchanged since the install
and leaves (and logs) any the person edited; a failed removal is logged and
tried again on the next start. Pane removes one only when its receipt shows an
older Pane installed it: from the bundled package's `plugins/<name>` folder, or
from the pack whose source is the stock `greenfield-inc` repository. A plugin of
the same name made in the Profiles editor, one that arrived through profile sync
(`sync.json` records it as a save), or one whose receipt doesn't say where it
came from is kept, and the log says so. A retired plugin's receipt that isn't valid JSON
would make every Agent Farm install there fail, so Pane renames it to
`<name>.json.unreadable-<time>` (keeping its bytes and the plugin's files) and
logs where it went. When an unchanged bundle's manifest still lists a retired
plugin, Pane rewrites only the manifest and leaves greenfield's files alone. A
bundled plugin whose files no longer match Agent Farm's install receipt
(`.plugins/<name>.json`), because someone edited, added or removed a file, is
kept as it is: Pane updates no longer replace it, the log names it, and the
manifest lists it under `edited`. When a new bundle arrives, Pane first checks
such a kept plugin with the new Agent Farm's `plugin validate` (on a copy
without the pack's checksums, as the Profiles editor does). One it rejects (an
edited greenfield from Agent Farm 0.2 can name a variant 0.3 refuses, and then
`profiles list` fails for every plugin, leaving New Session with no named
profiles) is saved unchanged, its files and receipt, with a `README.txt` on what
happened, in `<PANE_DIR>/agent-farm/recovered/<name>-<version>-<time>/`, and the
copy this Pane ships is installed in its place; the log names the folder. With
Profiles on, the Profiles tab says so once ("Your edits to <plugin> didn't work
with this version of Agent Farm. They're saved in <folder>."), with Open folder
and a dismiss button; dismissing it marks the folder's `recovery.json`, so it
stays dismissed. If that copy can't be saved, the edit is kept as it is. This holds with Profiles on or off, so
turning Profiles off never lets an update overwrite a plugin edited while it
was on. An install that never finished (its lock, a
plugin Pane was installing then, recorded in `pane-installing.json`, or one with
no receipt) is cleared before the next one, and a failed install is logged and
never blocks startup. With Profiles on (Settings › Advanced › Experimental), the
sidebar's **Profiles** tab lists every profile Agent Farm's
`profiles list --json` lists (greenfield's Orchestrator, Business and SEO, and
any of your own), pinned ones first, each with Agent Farm's title, description
and SVG photo. Every other role is an agent a profile links to, and shows in its
tree. With Profiles off there is no tab and its channels refuse. A profile opens on its cover page,
`covers/<profile>.html` or `.md` in the plugin when there is one (HTML is shown in
a sandboxed frame with no scripts and no network), otherwise one Pane makes from
its title, description, identity, subagents, skills and references. Beside it, a
tree holds that profile's own files (its identity, instructions, skills,
references and settings) and, under Subagents, the agents it links to, drawn from
the listing's `tree`. Each linked agent says how it runs (inside its parent,
its own process, or its own launch), whether it has Claude and Codex versions, and
nests its own files and links; a link back to an agent already above it is
marked as a cycle and not expanded again. An agent that runs as its own process
or launch opens in a terminal tab from its row's tab button, ⌘↩ (Ctrl+Enter) on
the row, or **Open in a tab** on its cover (in the cover's header when the cover
is its own file): the tab runs the command the listing
gives it, unchanged and with no `--parent` (a person needs no permission), in
the Pane you came to Profiles from, and Pane then shows that Pane with the new
tab in front. With no Pane to open it in, a notice says so and nothing starts.
When a remote host never confirms the tab, the notice says it may have started
and to check that Pane before trying again. If you leave Profiles, or open it
again from elsewhere, before the host makes the tab, the tab is added but Pane
doesn't move you to it. The tab resumes like any
Agent Farm tab (`--resume <id>`). An orchestrator opens its own linked agents
with `runpane panels create --tool-command "<its link's command>"`, which
carries `--parent` and, from Agent Farm 0.3.1, `--snapshot` (the Session's frozen plugins;
see [SESSIONS.md](SESSIONS.md#switch-and-reload-profile-profiles-on)). Files preview first (Markdown with its
front-matter as a metadata header, YAML as key/value) and **Edit** opens the
source. **Edit details** saves a profile's title and description, and its photo
menu an SVG photo (at most 64 KB), with `agent-farm profiles set`. Agent Farm
checks the SVG (no scripts, external links or embedded pages) and keeps all three
as its own display override in `<PANE_DIR>/agent-farm/profile-overrides/`, so
they survive Pane reinstalling greenfield on an update, don't make it **Edited**,
and an empty value goes back to the plugin's own. Photos are shown only as images.
The tab edits the plugins in
place: a save is first checked with `agent-farm plugin validate` on a staged copy
(without a pack's stale `checksums`, which launches don't read), so nothing changes
unless Agent Farm accepts it, and Sessions using the plugin then show the changed
dot. Saving greenfield makes it **Edited** this way, and **Restore
Pane's version** reinstalls the bundled copy and takes it off `edited`. A new
profile is a plugin installed with `agent-farm plugin install`, since Agent Farm
finds plugins by their receipts. `run` writes its launch bundle to
`<worktree>/.agent-farm/generated`, which Pane hides from git through
`info/exclude` as it does `.pane/`.

Telemetry with Profiles off is Agent Farm's own default, as before T-63: Pane
writes only `telemetry.directory` as `<PANE_DIR>/agent-farm/telemetry` into that
folder's `settings.json`, sets no `AGENT_FARM_TELEMETRY`, and shows no switch.
When Profiles first comes on, Pane records the `telemetry.enabled` that was there
(or that there was none) in `pane-telemetry.json` beside it, before writing its
own. Turning Profiles off puts that back, so an opt-out you set earlier survives;
a value changed by hand while Profiles was on is left as it is. Startup and every
settings change write through one queue (`agentFarmTelemetrySync`) that ends on
the latest switches, so quick toggles never leave a stale value.

With Profiles on, telemetry is off unless Settings › AI & Agents › *Save Agent Farm telemetry on
this computer* (`agentFarmTelemetry` in `<PANE_DIR>/config.json`) is on: Pane writes
`telemetry.enabled` from that switch, and `telemetry.directory` as
`<PANE_DIR>/agent-farm/telemetry`, into that folder's `settings.json` at start and
whenever the switch changes. Each computer keeps its own switch. A repository's
`.agent-farm/workspace.yaml` outranks `settings.json` in Agent Farm, so every
Agent Farm Pane runs (chat launches, Session move, the terminal shim) also gets
`AGENT_FARM_TELEMETRY=off`, the one setting that outranks a workspace, unless the
saved switch and `settings.json` both say on. Chat launches pass Pane's live
Profiles state, so a `config.json` that can't be read never lifts that hold;
without a caller's state, an unreadable `config.json` counts as telemetry off. The saved switch is what Settings
shows, so turning it off holds even if writing `settings.json` failed; Pane retries
that write at the next settings change and the next start. While the switch is
on, a repository's settings can still turn telemetry off or name another folder;
the files stay local (an accepted exception, D-T63-1). An
`AGENT_FARM_TELEMETRY` already in the environment overrides the switch either way,
and Settings says to remove it there to let the switch decide. Agent Farm still keeps
small state of its own (workspace trust, launch records, MCP logins) under
`~/.local/state/agent-farm` and `~/.cache/agent-farm`. `scripts/verify-chat-adapters.js` (run by
`scripts/after-pack.js`) fails a packaged build unless Agent Farm is inside
`app.asar`, carries no native binaries, answers `--version` under Electron
as Node, has its plugins packed byte for byte as installed (packing once stripped
`scripts` from a plugin's `package.json`, which Agent Farm's checksum check
refuses), and installs its bundled greenfield plugin into a scratch config root.

### Profile sync across your computers

Sync runs only with [Profiles](#profiles-switch) on. Off, nothing is recorded or
sent, a Session starts without first fetching its profile, and the
`profile-sync:*` calls refuse with `ERR_PROFILES_OFF`, which another computer's
Sync sheet shows as "Profiles is off there". Turning the switch off during a sync
stops it: an install already under way finishes, and nothing more is fetched,
sent, installed or remembered. Turning the switch on starts syncing without a
restart.

Every change to a plugin here (a save, a new profile or file, Restore, a photo,
a plugin installed or removed with `agent-farm plugin install` or `uninstall`,
or a plugin's files edited outside Pane) is recorded in
`<PANE_DIR>/agent-farm/sync.json`: the plugin's sync hash (its files, ignoring a
pack's `checksums`, plus its photos), the save time and this computer's install
id, or a deletion. The desktop (`services/agentFarm/profileSyncCoordinator.ts`)
reads every saved computer's records over the machine connection
(`profile-sync:state`), brings this computer up to the newest save of each
plugin, and sends it to every computer that is behind. The newest save wins;
equal times go to the lower install id; nothing is merged. It runs on start,
after a save here, when a plugin, receipt or display override in
`<PANE_DIR>/agent-farm` changes outside Pane (a file watcher, while the switch
is on; a change waits while Agent Farm holds `.plugins/install.lock`, unless the
lock is over 10 minutes old), when a computer comes back online or reports
`profiles:changed`, and for one plugin before a Session starts, switches to or
reloads it (here, or on the machine a remote Session is created on). That
Session sync reads and is sent only its own profile's receipt and record, and it
never marks a computer up to date: only a full sync does. The Profiles tab's
**Sync** button sends everything again and lists each computer's state; its footer
says what an offline computer gets when it reconnects.

A save travels as one pack (`profile-sync:export`/`read` to pull,
`profile-sync:write`/`apply` to push) with Session move's chunked, SHA-256-checked
transfer. The receiving computer checks the pack's hash, then installs it with
`agent-farm plugin install`, which refuses files that don't match the checksums
in its plugin.yaml. What Agent Farm's install leaves out travels in the pack
too and is written after the install: the Profiles tab's `covers/` pages, and the
plugin's display overrides (your titles, descriptions and SVG photos, from
`profile-overrides/<plugin>/`). The plugin, its receipt and its overrides there are set
aside first (nothing there is removed until both have been) and put back if
anything before the record is written fails; a
deletion is recorded only when a plugin's receipt is certainly gone, never on a
read that failed. greenfield syncs only once you change it: a title, description
or photo alone keeps each computer's own Pane version (`pane` records), an edit travels as
your copy and stays **Edited** there (Pane updates keep it while Profiles is on;
off, Agent Farm's receipt alone decides, as before), and Restore restores
Pane's version everywhere. The calls answer only your own machines, never a
teammate on a shared tailnet. Two dev instances on one computer sync through
`PANE_MOVE_TEST_PEERS`, as a Session move does (CONTRIBUTING.md).

### A Session's Agent Farm profile

With [Profiles](#profiles-switch) on, a Session's orchestrator chat runs an Agent
Farm profile (see [SESSIONS.md](SESSIONS.md#sessions-run-through-agent-farm)). With no profile it is
Pane's own plugin, `pane`, which Pane writes from its agents contract
(`chat.profileModel`) and installs beside the bundled plugins at every start
(`main/src/services/agentFarm/agentFarmProfiles.ts`); its profiles `pane/claude`
and `pane/codex` hold only the harness and model, and an edit there is replaced.
When Pane resolves a Session's printed launch it:

- moves the profile's instructions (Claude's `_meta.systemPrompt.append`, Codex's
  `CODEX_CONFIG` `developer_instructions`, both with LAUNCH CONTEXT) into the
  Session folder as `PROFILE.md` and a marked section of its `AGENTS.md`, which
  `CLAUDE.md` imports. A resumed conversation reads instruction files again but not
  a launch's system prompt, so a later reload or switch of profile reaches it.
  Pane marks its `PROFILE.md` on the first line and replaces or removes only a
  marked one: a `PROFILE.md` a person or agent wrote stays as it is;
- turns Claude's `strictMcpConfig` off, so the person's own MCP servers stay, and
  adds Pane's MCP server over HTTP with the deny for the Claude plugin's own `pane`
  server, as a plain chat tab does. Codex keeps its config through Agent Farm's
  private Codex home, which links `~/.codex`;
- for `pane/*`, drops Agent Farm's full-access mode: the agent asks as it did when
  Pane started it directly, unless the Session's launch gave it full access
  (`fullAccess` on the profile launch). Every other profile keeps Agent Farm's mode.

A profile chat tab outside a Session runs exactly as printed. A Session's agent that
starts without Agent Farm (Profiles off, or a direct agent such as OpenCode) has
Pane's `PROFILE.md` and `AGENTS.md` profile section taken out of its folder first.

With Profiles off, none of this happens and Sessions start as before T-63: a
profile launch (a launch command's `agent-farm run <profile>`) runs exactly as
printed, Session folders get no `PROFILE.md` (Pane's own, written while Profiles was
on, is removed at the agent's next start, a chat restart included), a tab saved with
a profile Pane chose (`pane/<agent>`, or the Session's named profile, marked
`fromSession`) starts that agent on its own (`withoutPaneProfile` in
`chatTabs/launch.ts`), and
`chat-tab:profiles` lists nothing. Pane still installs its `pane` plugin into its own
Agent Farm at start either way: nothing reads it while Profiles is off, and turning
Profiles on then needs no restart.

Switch and Reload profile (see [SESSIONS.md](SESSIONS.md#switch-and-reload-profile-profiles-on))
restart the tab with `ChatTabManager.relaunch`: the request is saved as the tab's
`relaunch` and applied when no reply is in progress, before the next queued message.
The new launch and a new conversation's handoff (the transcript prompt, first in
the queue) are saved before the old agent stops, and the tab starts nothing until
it has; a `stop` still ending the agent is waited for too. A kept conversation is
loaded again with the new launch; `loadFallback` names the private transcript (in
the tab's chat-tabs folder) a failed load falls back to. Each change adds a `dividers` entry, a
`pane_divider` row that the history replay puts back after the message it followed,
as it does turn times. With Profiles off, nothing calls it, and a request still
waiting is dropped.

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
| @, $ and / rules, shared by every client and the host | `shared/composerMentions.ts` |
| File search (`chat-tab:files`, `file:search`) | `main/src/services/fileSearch.ts` |
| How a skill is sent | `main/src/services/chatTabs/skillDispatch.ts`, `sentMessages.ts` |
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
