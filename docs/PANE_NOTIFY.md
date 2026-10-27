# Pane Notify

Agents ask you questions through Pane instead of waiting in their terminal.
An agent calls the `notify` MCP tool (or `runpane notify`), Pane shows the
question wherever you are, even over your browser, and the agent gets your
answer as the tool's result.

## What an agent can send

`notify` takes one `ui` value, which picks the card:

| `ui` | Card | Result |
| --- | --- | --- |
| `options` | The question and 1 to 9 `choices` (`{label, detail?, recommended?}`). The strip shows four, then **More**. | `{answer, note?}` |
| `approve` | Deny and Approve, plus a disclosure with the preformatted `detail`. `detailLabel` names the disclosure (up to 40 characters; default **Show details**). | `{approved, note?}` |
| `ask` | A text field, with optional `suggestions` as chips above it. | `{answer}` |
| `info` | One line, with at most one `action` button (`{label, url}`). It returns at once and hides after a few seconds. | `{delivered: "screen" \| "inbox"}` |

Every card takes a `title` (one line on the strip, wrapping to three) and an
optional `context` shown under **Details** and in the round.

When Notify is off or Pane isn't running, the result is
`{unavailable, next}` and the agent asks in its terminal as it does today.

```sh
runpane notify --ui options --title "Which session store should the refactor use?" \
  --choices '[{"label":"Postgres table","recommended":true},{"label":"Keep Redis"}]'
```

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
the card says "<agent> stopped waiting" and the question moves to **Earlier
today** as Expired. Codex 0.164 doesn't tell Pane when you press Esc, so a question from a
Codex panel also expires when that panel sits idle at its prompt for 10 seconds.

## Where questions show

- **The strip**: a borderless card at the bottom center of the screen with the
  pointer. It never takes keyboard focus when it appears; click a choice to
  answer, or click its text field to type. After you answer, it shows
  "Sent to <agent>" with **Undo** for 3 seconds before the agent gets it. Only
  one strip is ever on screen, oldest question first.
- **The round**: press ⌃⇧Space (Ctrl+Shift+Space on Windows and Linux) from
  any app for a centered panel that works through the queue by keyboard:
  number keys or arrows choose, ↵ sends, → skips, Tab adds a note, Esc closes.
- **Inside Pane**: with Pane in front, the strip sits at the bottom of the main
  area, Panes with a waiting question show an amber dot and "Waiting" in the
  sidebar, and **Notify** in the sidebar opens the inbox: waiting questions,
  updates, and what you answered earlier today. **Open in Pane** jumps to the
  asking terminal with the card docked under its output.
- **The menu bar or tray icon** shows an amber dot while questions wait. Its
  menu lists them and holds Show outside Pane, Pause for 1 hour, Open Notify
  inbox and Notify settings.

**Keys on a card.** With the pointer over a card inside Pane (the in-Pane strip,
the inbox, a docked card), its keys work: a choice's number answers it, Y
approves, N starts a denial, and typing starts an ask's answer. The floating
strip over another app takes keys once you click it, so typing in that app never
answers by accident. Keys work whatever Pane's keyboard-shortcuts setting says.

✕ hides a question from the strip; it keeps waiting in the inbox.
Right-click ✕ to bring it back in 10 minutes, in 1 hour, or when you next
switch to Pane. Nothing is stored on disk: questions live only while the
agent's call is open, and Earlier today empties at midnight and when Pane
quits.

## Other screens and your phone

The machine running the agent keeps the one queue. Every screen connected to
it shows its questions, and the first answer from any of them goes back to
the agent:

- **A Pane desktop connected to another machine** (Remote Access pairing or
  Workspaces) shows that host's questions on every surface above: the strip
  over other apps, the round, the tray dot, the chime, the inbox, the Waiting
  dots and Open in Pane, which opens the host's Pane in this window and leaves
  the host's own window where it is. Questions from agents on the connected
  desktop's own machine still show beside them, and each card names its
  machine ("notify-remote · Claude · parsa-devbox").
- **Several screens at once**: the screen you answer on says "Sent to
  <agent>", every other one says "Answered on <device>", and all of them offer
  **Undo** for the 3 seconds before the agent gets the answer. ✕, the
  reminders and → in the round apply on every screen, except "When I switch to
  Pane", which waits for the Pane you used it on.
- **Connection loss**: while the host can't be reached its cards stay up and
  say "Not sent: can't reach <host>. Try again when it reconnects."; the agent
  keeps waiting. After reconnecting the screen shows what is waiting now.
- **Your phone**: each question sends one alert at once to every phone signed
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
  hosts) has no screen of its own: it creates no Notify window, tray icon or
  shortcut, and its questions show on whoever is connected and on the phone.
  With nobody connected a question waits until someone connects or answers.
  An update from it returns `delivered: "inbox"`; connected screens still show
  it on their strips.

Each screen keeps its own Position, Show outside Pane, Sound, answer-all
shortcut and Pause. The host's Notify switch decides whether agents can ask:
turning it off there returns `unavailable` to every waiting agent and clears
its questions from every screen.

## Settings

**Settings → Notify**:

| Setting | Default |
| --- | --- |
| Notify | On. Off returns `unavailable` to every waiting agent. |
| Show outside Pane | On. Off shows strips only while Pane is in front; the tray dot still shows. |
| Position | Bottom center. Also top right or bottom right. |
| Answer-all shortcut | ⌃⇧Space. Settings says so when another app already holds it. |
| Updates hide after | 6 seconds |
| Sound | On, for questions only |

Pause for 1 hour (tray menu) hides strips and mutes sound while questions keep
queueing. Strips show over full-screen apps, during screen sharing, and with
Focus or Do Not Disturb on; Pause is the way to quiet them.

## What Pane tells agents

While Notify is on, Pane keeps a short block in each agent's user-level
instruction file, so every agent knows to ask through `notify`:

- Claude Code: `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`)
- Codex: `~/.codex/AGENTS.md` (or `$CODEX_HOME/AGENTS.md`)

The block sits between `<!-- pane-notify:begin ... -->` and
`<!-- pane-notify:end -->`. It says when to ask (only what the agent can't
find out itself, related questions in one card, `info` rarely) and how to
write a card for someone who has lost the thread: what the work is for, what
just happened, and what is needed. Pane writes only those lines, plus a line
break before them when the file didn't end with one; the rest of the file keeps
every byte. It creates the file only when the agent's config folder exists and
never deletes it. It leaves alone a file that is a symlink or not a regular
file, isn't UTF-8, or has a stray marker, and one that another program keeps
saving while Pane writes. Settings → Notify → Agent instructions shows each
file's state.

To remove the block, turn Notify off in Settings → Notify. Pane writes it
again when you turn Notify back on, or at the next launch with Notify on.

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
Questions show in the in-Pane strip and the Notify inbox, with Waiting dots and
the chime. The tray icon and its dot work; GNOME needs the AppIndicator
extension, which Ubuntu turns on by default. On GNOME 46 (Ubuntu 24.04), which
has no global-shortcut portal, ⌃⇧Space doesn't reach Pane from other apps;
inside Pane it opens Answer all, and so does **Answer all** in the inbox.

The code: `main/src/services/notify/` (queue, windows, tray),
`main/src/ipc/notify.ts` (including the `notify:remote-snapshot` and
`notify:remote-command` commands and the `notify:shared-changed` event other
screens use), `main/src/daemon/mobilePushSender.ts` (the phone alert),
`shared/types/notify.ts`, and the renderer's Notify components with the
`frontend/notify.html` entry for the floating windows.
