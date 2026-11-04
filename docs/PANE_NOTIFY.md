# Approvals (Pane Notify)

Agents ask you questions through Pane instead of waiting in their terminal.
An agent calls the `notify` MCP tool (or `runpane notify`), Pane shows the
question wherever you are, even over your browser, and the agent gets your
answer as the tool's result. Inside Pane, everything that waits on you is in
**Approvals**, filed under the Session it belongs to. `notify` is the agents'
side of it, and keeps its name in the CLI, the MCP server and the code.

## What an agent can send

`notify` takes one `ui` value, which picks the card:

| `ui` | Card | Result |
| --- | --- | --- |
| `options` | The question and 1 to 9 `choices` (`{label, detail?, recommended?}`). The strip shows four, then **More**. | `{answer, note?}` |
| `approve` | Deny and Approve, plus a disclosure with the preformatted `detail`. `detailLabel` names the disclosure (up to 40 characters; default **Show details**). | `{approved, note?}` |
| `ask` | A text field, with optional `suggestions` as chips above it. | `{answer}` |
| `secret` | A masked field with **Save securely** and **Decline**. Created only by `runpane secrets request` (MCP `secrets_request`), never with `notify --ui`. The host saves the value as a [Pane secret](PANE_SECRETS.md) and drops it; it never reaches the agent, history or other screens. No Undo. | `{status: "saved", project, name}` or `{status: "declined"}` |
| `info` | One line, with at most one `action` button (`{label, url}`). It returns at once and hides after a few seconds. | `{delivered: "screen" \| "inbox"}` |

Every card takes a `title` (one line on the strip, wrapping to three) and an
optional `context` shown under **Details** and in the round. Any card also
takes up to 6 `links` (`--links`), related files and pages shown as chips:
`{label, path}` for a file on the asking machine (relative to its working
directory) or `{label, url}` for an http or https page. Older Panes ignore them.
In Approvals, clicking a chip opens it as a tab beside the card: a file in an
editor tab, a page in a browser tab.

When Approvals is off or Pane isn't running, the result is
`{unavailable, next}` ("Approvals are off in Pane.") and the agent asks in its
terminal as it does today.
For an API key, token or password, agents call `secrets_request` (or
`runpane secrets request`), never `ask`. When that returns `unavailable`, the
agent asks you to save the secret in Pane under Settings > Secrets.

```sh
runpane notify --ui options --title "Which session store should the refactor use?" \
  --choices '[{"label":"Postgres table","recommended":true},{"label":"Keep Redis"}]' \
  --links '[{"label":"Plan","path":"docs/plan.html"},{"label":"PR #12","url":"https://github.com/acme/app/pull/12"}]'
```

## Who asks: Sessions

Pane files each item under the Session its Pane belongs to (a Session's own
orchestrator tab is marked as the orchestrator). Items from a Pane in no
Session go under "Not in a Session".

- **Workers in a Session don't call `notify`.** A worker reports blocked to
  its orchestrator (`runpane report --state blocked --question "<question>"`),
  and the orchestrator decides what reaches you.
- **A Session orchestrator** keeps every item that waits on you posted to
  Approvals exactly once, titled with its Q-n and with the worker's files as
  links. It posts each one with `runpane notify ... --json` as a background
  command, so it stays free to talk: you can ask it about an item in its own
  tab while the card waits, and its background call returns your answer. It
  stops the call of an item that went stale, which expires the card, and it
  posts again after a restart, because Pane keeps no approvals across one. The
  full rule is in the orchestrator guide
  (`runpane docs read --doc skills/pane-orchestration/SKILL.md`, "What waits
  on the person").
- **Any other agent** calls `notify` as before.
- **Fallback.** When a worker's blocked question sits unacknowledged in its
  Session's inbox for 10 minutes (the orchestrator is down, or follows an
  older rule set), Approvals shows it read-only: "Waiting on the <Session>
  orchestrator: <worker> asked this and it hasn't been picked up. Answer in
  the orchestrator's tab." It has no answer buttons. It goes away when the
  orchestrator acknowledges the inbox (`runpane inbox ack`) or the worker
  reports again, and never shows while Approvals is off.

Claude's permission prompts and chat tab prompts (below) still come straight
from the asking tab, filed under its Session.

## Claude's own prompts

Claude tabs Pane starts also ask their permission and plan prompts in Approvals,
without the agent calling `notify`. The terminal shows the prompt as usual;
the first answer from the terminal, Approvals, the strip or the phone wins.

- **Desktop Approvals** shows Claude's choices: Yes, each "Yes, and don't ask
  again for …" or "Yes, and allow access to …" that Claude suggests, and No.
  A note on No tells Claude what to do instead; without one, Claude stops and
  waits, as No does in the terminal. A plan shows its text with "Yes, and
  auto-accept edits", "Yes, and manually approve edits" and "No, keep
  planning".
- **The phone** lists the prompt in Approvals with **Yes** and
  **No**, and its alert carries the same two buttons. The question's sheet has
  every choice.
- **Answered in the terminal**: Pane closes the question and lists it in
  Answered as "Answered in the terminal".
- **The whole command, plan or tool input** is on the card, so Yes never
  approves something you couldn't read. One over 32,000 characters is too long
  to show: its question offers no choices and says to answer in the terminal.
- **After 10 minutes** Claude stops waiting on Pane. The question stays, says
  "Claude is asking in the terminal now" with **Open**, and loses its choices;
  answering in the terminal clears it. An answer still in its 3-second Undo
  hold then never reaches Claude, so it is dropped the same way.
- **The first prompt** after an update adds a one-time note to Approvals.

How it works: each Claude launch gets an http `PermissionRequest` hook aimed
at a loopback endpoint on the machine running it, with a token for that tab.
Claude reads only the last `--settings` flag, so Pane writes one settings file
per tab (owner-only, in `claude-prompts` under Pane's data folder) that merges
its hooks with any `--settings` the command already passes, and launches with
that file instead. A command whose `--settings` Pane can't read, or a tab
whose settings file Pane can't write, launches unchanged. Wrapped launches, commands that don't start with `claude`, SSH tabs
and WSL tabs keep their command, and their prompts stay in the terminal.

Turn it off in **Settings → AI & Agents → Answer prompts from Pane**. Off
takes effect at once; a tab started while it was off picks it up when it
restarts.

## Chat tab prompts

[Chat tabs](CHAT_TABS.md) send their ACP approvals to Approvals too, with exactly
the choices the adapter sent (the phone's Yes and No are its allow and reject
choices). A question (ACP form) is asked one field at a time, titled "(1 of 3)"
with the field's title when it has more than one: single choice and yes/no as
options, multiple choice as free text naming the choices (comma-separated, with
each choice as a chip), text and numbers as free text. A typed answer to a
choice fills the form's matching free-text field (AskUserQuestion's
`question_0_custom`). The last field sends the whole form as one answer; "Skip
question" declines it. The first answer wins: an answer from Approvals reaches
the agent, and a card the chat tab answered first closes as "Answered in the
chat", along with the rest of its form. In Approvals the card shows beside the
chat tab, which docks the same prompt above its composer.
**Settings → AI & Agents → Answer prompts from Pane** turns this off too. A chat tab waiting on a prompt reports
`blocked`, so phone alerts follow it like a terminal agent's.

## Long waits

A question waits until you answer it. How the call stays open depends on the
client:

- **Claude Code and Codex** wait in one call. Claude Code moves a call that
  runs past about 2 minutes into a background task and ends its turn; your
  answer still reaches the agent when you send it. Pane's MCP server sends a
  progress notification every minute, and Pane registers the server with
  Codex using a 24-hour tool timeout.
- **Cursor's CLI** ends every tool call after 60 seconds. About every 50
  seconds `notify` returns `{waiting: true, id, next}`, and the agent calls
  `notify` again with `resume: <id>`. The card doesn't change. After 15
  minutes without an answer the call returns `unavailable`. Cursor asks
  "Run this MCP tool?" before every call, resumes included; pick **Allowlist
  MCP Tool** once so a waiting agent doesn't stop at that prompt.

If the agent stops waiting (you interrupt it, it exits, or its call times out),
the card says "<agent> stopped waiting" and the question moves to
**Answered** as Expired. Codex 0.164 doesn't tell Pane when you press Esc, so a question from a
Codex panel also expires when that panel sits idle at its prompt for 10 seconds.

## Where questions show

- **Inside Pane: Approvals.** An amber **Approvals** badge in the title bar
  shows how many items wait; clicking it, or pressing ⌃⇧Space while Pane is in
  front, opens the Approvals screen in the main area, and clicking the badge
  again returns you to the view you left. The sidebar keeps the Sessions list,
  and Panes and Sessions with a waiting item show an amber "Waiting". Beside
  it, the queue has **Waiting** and **Answered** tabs and groups items by
  Session, with counts and machine marks, "Not in a Session" last. The
  selected item opens in place as a card (its title, context, links and
  answer controls). Next to it is its Session, live: an orchestrator's item
  shows the Session's orchestrator tab (its chat tab where chat tabs are on,
  its terminal where they are off), so you can ask it about the item in its
  own composer; a worker's prompt or a standalone item shows the asking Pane's
  tabs. A link opens as a tab there: a file inside that Pane's worktree in an
  editor, any other file as a page (`file://`, as orchestrators show pages),
  a URL as a browser tab. Another machine's item offers **Open on
  <machine>**, which switches to it. Below about 1,100px wide, the queue stacks above the Session. After
  you answer, the card shows "Sent to <agent>" with **Undo** for 3 seconds,
  then moves to Answered, which also lists today's updates (`ui info`). Nothing is drawn over your work inside Pane: there
  is no in-Pane strip, docked card or Notify row in the sidebar.
- **The strip**: while Pane isn't in front, a borderless card at the bottom
  center of the screen with the pointer. It never takes keyboard focus when it
  appears; click a choice to answer, or click its text field to type. After
  you answer, it shows "Sent to <agent>" with **Undo** for 3 seconds before
  the agent gets it. Only one strip is ever on screen, oldest question first.
  **Open in Pane** brings Pane to the front on Approvals with that item
  selected.
- **The round**: press ⌃⇧Space (Ctrl+Shift+Space on Windows and Linux) from
  any other app for a centered panel that works through the queue by
  keyboard: number keys or arrows choose, ↵ sends, → skips, Tab adds a note,
  Esc closes.
- **The menu bar or tray icon** shows an amber dot while questions wait. Its
  menu lists them and holds Show outside Pane, Pause for 1 hour, a way into
  Approvals, and its settings.

**Keys on a card.** With the pointer over a card in Approvals, its keys work:
a choice's number answers it, Y approves, N starts a denial, and typing starts
an ask's answer. The floating strip over another app takes keys once you click
it, so typing in that app never answers by accident. Keys work whatever Pane's
keyboard-shortcuts setting says.

✕ hides a question from the strip; it keeps waiting in Approvals.
Right-click ✕ to bring it back in 10 minutes, in 1 hour, or when you next
switch to Pane. The clock at the bottom right of a card snoozes it for 3, 5
or 15 minutes: it leaves the strip, then comes back in its place in the
queue, and Approvals shows it with its return time. The agent keeps
waiting through a snooze or reminder. Nothing is stored on disk: questions
live only while the agent's call is open, and the Answered tab empties at
midnight and when Pane quits.

## Other screens and your phone

The machine running the agent keeps the one queue. Every screen connected to
it shows its questions, and the first answer from any of them goes back to
the agent:

- **A Pane desktop with saved machines** (Remote Access pairing or
  Workspaces) shows every saved machine's questions beside its own, whichever
  machine it is on: the strip over other apps, the round, the tray dot, the
  chime, Approvals, the badge count and the Waiting dots. Each card names its
  machine ("notify-remote · Claude · parsa-devbox"), and Approvals shows the
  machine's mark in its Session's group; beside it, **Open on <machine>**
  switches to that host instead of a live Session view. An answer, Undo, ✕, snooze or → goes to the card's own
  machine and clears there; nothing switches. Open in Pane shows on this
  computer's cards and on the machine the desktop is on, where it opens the
  host's Pane in this window and leaves the host's own window where it is.
- **Several screens at once**: the screen you answer on says "Sent to
  <agent>", every other one says "Answered on <device>", and all of them offer
  **Undo** for the 3 seconds before the agent gets the answer. ✕, snooze, the
  reminders and → in the round apply on every screen, except "When I switch to
  Pane", which waits for the Pane you used it on.
- **Connection loss**: while a machine can't be reached its cards stay up,
  its mark dims, and they say "Not sent: can't reach <machine>. Try again
  when it reconnects."; the agent keeps waiting. After reconnecting the screen
  shows what is waiting there now. While Pane runs, an unreachable machine's
  cards stay until it is removed from the saved machines or turns Approvals off;
  a machine offline when Pane starts shows its questions once it connects.
- **Your phone**: the Pane app lists Approvals grouped by Session, and an
  item opens above its Session's tabs and chat. Each question sends one alert at once to every phone signed
  in to the host in the Pane app with notifications allowed and **Needs
  Input** on. The alert is titled with the Pane's name and says only "<Pane>
  has a question" (the folder name for a call from outside Pane); updates
  (`info`) send none. When the question is answered elsewhere or its agent
  stops waiting, the host sends a silent update so the phone can remove the
  alert, and an Undo makes it alert again. The host needs its usual phone
  credentials (`PANE_APNS_*` or the shared ones for iPhone, FCM for Android;
  see [NATIVE_MOBILE.md](NATIVE_MOBILE.md)); without them nothing is sent and
  the question still waits on every screen.
- **A headless host** (`runpane install daemon`, remote setup, workspace
  hosts) has no screen of its own: it creates no strip window, tray icon or
  shortcut, and its questions show on every desktop that has it saved and on
  the phone. With none of them running, a question waits until one connects
  or answers.
  An update from it returns `delivered: "inbox"`; connected screens still show
  it on their strips.

Each screen keeps its own Position, Show outside Pane, Sound, Show details, answer-all
shortcut and Pause. The host's Approvals switch decides whether agents can ask:
turning it off there returns `unavailable` to every waiting agent and clears
its questions from every screen.

## Settings

**Settings → Approvals** (the setting is still saved as `notify.enabled`):

| Setting | Default |
| --- | --- |
| Approvals | On. Off hides the badge, expires open cards, returns `unavailable` ("Approvals are off in Pane.") to every waiting agent, and drops fallback items. Agents, Session orchestrators included, then ask in their own tab. |
| Show outside Pane | On. Off shows strips only while Pane is in front; the tray dot still shows. |
| Position | Bottom center. Also top right or bottom right. |
| Answer-all shortcut | ⌃⇧Space. Settings says so when another app already holds it. |
| Updates hide after | 6 seconds |
| Sound | On, for questions only |
| Show details | Off. Cards open with details shown when on. Showing or hiding details on a card changes it. |

Pause for 1 hour (tray menu) hides strips and mutes sound while questions keep
queueing. Strips show over full-screen apps, during screen sharing, and with
Focus or Do Not Disturb on; Pause is the way to quiet them.

## What Pane tells agents

While Approvals is on, Pane keeps a short block in each agent's user-level
instruction file, so every agent knows Pane is there and asks through `notify`:

- Claude Code: `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`)
- Codex: `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`). Agent Farm's
  Codex launches use a generated `CODEX_HOME` that links this file, so they
  read it too.
- On Windows, the same two files in the home of each WSL distro a project
  runs in (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` as that distro's login shell
  sets them). Pane writes them at launch and when you change the settings
  below; a distro that doesn't answer is shown as skipped and tried again at
  the next launch.

The block sits between `<!-- pane-notify:begin ... -->` and
`<!-- pane-notify:end -->`. Pane writes it at first launch, since Approvals is
on by default. It has two parts:

- **Pane:** when `PANE_SESSION_ID` is set, the agent is in a Pane terminal
  and should load the `pane` skill before using Pane. With the skill turned
  off (Settings → AI & Agents → Install Pane skill for agents), it points at
  `runpane agent-context --json` instead. If `runpane` isn't on `PATH`, the agent runs `$PANE_RUNPANE_BIN`
  (PowerShell: `& $env:PANE_RUNPANE_BIN`), or else the installed Pane's shim:
  `~/.pane/bin/runpane` on macOS and Linux,
  `C:/Users/<you>/.pane/bin/runpane.cmd` on Windows (forward slashes, so
  PowerShell, cmd and Git Bash all run it), and
  `/mnt/c/Users/<you>/.pane/bin/runpane` in WSL. The path is always the
  default data folder's, so a dev build with its own `PANE_DIR` never points
  your agents at its copy.
- **Pane Notify:** call the `pane` MCP's `notify`, or `runpane notify` when
  that tool isn't loaded (for example under Agent Farm's strict MCP mode).
  It says who asks (in a Session, a worker reports blocked to its
  orchestrator instead of calling `notify`, and the orchestrator posts in the
  background; any other agent calls `notify`), when to ask (only what the
  agent can't find out itself, related questions in one card, `info` rarely)
  and how to write a card for someone who has lost the thread: what the work
  is for, what just happened, and what is needed.

Pane writes only those lines, plus a line
break before them when the file didn't end with one; the rest of the file keeps
every byte. It creates the file only when the agent's config folder exists and
never deletes it. It leaves alone a file that is a symlink or not a regular
file, isn't UTF-8, or has a stray marker, and one that another program keeps
saving while Pane writes. Settings → Approvals → Agent instructions shows each
file's state.

To remove the block, turn Approvals off in Settings → Approvals. Pane writes it
again when you turn Approvals back on, or at the next launch with Approvals on.

The `pane` MCP server's instructions carry the same rules, plus good and bad
example cards; that is how Cursor learns them.

## Linking a call to its Pane

Pane sets `PANE_SESSION_ID` and `PANE_PANEL_ID` in every terminal it opens.
Claude Code passes them to MCP servers; Pane's registration forwards them for
Codex (`env_vars`) and Cursor (`${env:NAME}`). A call from an agent outside
Pane still works: its card shows the folder name and hides Open in Pane.

## Platforms

macOS, Windows and Linux on X11 show the strip over other apps. In a Wayland
session Pane runs as a native Wayland app and can't place a window over other
apps, so Show outside Pane is unavailable there (in Settings and the tray menu).
Questions show in Approvals inside Pane, with the badge, Waiting dots and
the chime. The tray icon and its dot work; GNOME needs the AppIndicator
extension, which Ubuntu turns on by default. On GNOME 46 (Ubuntu 24.04), which
has no global-shortcut portal, ⌃⇧Space doesn't reach Pane from other apps;
inside Pane it opens Approvals.

The code: `main/src/services/notify/` (queue, windows, tray),
`main/src/ipc/notify.ts` (including the `notify:remote-snapshot` and
`notify:remote-command` commands and the `notify:shared-changed` event other
screens use), `main/src/daemon/mobilePushSender.ts` (the phone alert),
`shared/types/notify.ts`, the renderer's Approvals screen
(`frontend/src/components/approvals/`) and Notify card components, and the
`frontend/notify.html` entry for the floating windows.
