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

✕ hides a question from the strip; it keeps waiting in the inbox.
Right-click ✕ to bring it back in 10 minutes, in 1 hour, or when you next
switch to Pane. Nothing is stored on disk: questions live only while the
agent's call is open, and Earlier today empties at midnight and when Pane
quits.

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

macOS, Windows and Linux on X11 show the strip over other apps. On native
Wayland, Pane can't place a window over other apps, so Show outside Pane is
unavailable there; the in-Pane strip, the tray icon (GNOME needs the
AppIndicator extension) and the shortcut still work.

The code: `main/src/services/notify/` (queue, windows, tray),
`main/src/ipc/notify.ts`, `shared/types/notify.ts`, and the renderer's Notify
components with the `frontend/notify.html` entry for the floating windows.
