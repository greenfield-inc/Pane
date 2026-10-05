# Computer Use

Computer use lets a coding agent see and operate desktop apps on a Pane machine.
The agent calls the `js` tool on the [`pane` MCP server](PANE_MCP.md) with a
short JavaScript script. The script reads an app's accessibility tree, clicks,
types and scrolls, and returns text and screenshots. It works with any agent
that uses the `pane` MCP server: Claude Code, Codex, Cursor and others. It runs on
macOS, Windows, and Linux desktops with X11.

Typical uses:

- QA a desktop or Electron app the agent just changed, including Pane itself.
- Read what an app shows when it has no API or CLI.
- Finish a task that exists only in an app's UI.

Apps are driven in the background, so you can keep working while the agent
runs. Every action leaves a screenshot of the target window, and the agent's
Pane keeps a replay of every run.

## Turn it on

Computer use is off by default and is set per machine. Only you should turn it
on. Agents get no MCP tool for it, and the skill tells them never to run the
command. `runpane computer-use on` also refuses to run inside a Pane terminal
(where `PANE_SESSION_ID` is set), which is where agents usually run. That refusal
slows agents down but is no security boundary. Any shell without that
variable, including an agent's, can still turn computer use on.

- **Desktop:** Settings → Remote Access → Computer use, or the status row in
  the host switcher. When Pane is connected to a remote host, the setting
  controls that host.
- **Headless host:** `runpane computer-use on [--engine auto|cua-driver]`,
  from a shell outside Pane. It exits non-zero unless the machine ends Ready,
  so setup scripts can check it. `runpane computer-use status` shows the
  state. Each command takes `--json`.

Turning it on installs the engine, registers the `pane` MCP server, installs
the `pane-computer-use` skill for Claude Code, Codex and Cursor, checks OS
permissions and runs a self-test. The status shows the result:

| Status | Meaning |
|---|---|
| Off | Computer use is off on this machine. |
| Installing… | Pane is installing the engine. |
| Needs permission: *permission* | Click **Open System Settings** and turn on **Cua Driver** in the Privacy pane it opens. On macOS it needs Screen Recording and Accessibility. Pane checks again every 5 seconds, so the status turns Ready soon after you grant it. |
| No desktop session | The machine has no graphical session to drive (for example a headless Linux server). |
| Install failed | Pane couldn't install the engine. **View details** shows why. **Check again** retries. |
| Self-test failed | **View details** shows the engine's error. **Check again** reruns the readiness step. |
| Ready · Cua Driver · checked *time* | Agents can use it. |
| Ready · Codex runtime · checked *time* | Agents can use it, through your installed Codex runtime. |

The engine choice next to the switch is **Auto** or **Cua Driver**:

- **Auto** uses the Codex runtime from your installed ChatGPT desktop app when
  it is installed and answers Pane, and Cua Driver otherwise. When Auto falls
  back, the Ready status says why, for example "Codex runtime not used: ChatGPT
  is not installed." It picks again on each check, so installing ChatGPT later
  switches it over.
- **Cua Driver** always uses [Cua Driver](https://github.com/trycua/cua), an
  open-source engine that Pane installs as a pinned release under its own data
  directory.

On a Mac, the first time Auto starts the Codex runtime, Pane sets the
user-wide macOS default `ComputerUseAllowForbiddenTargets` to `YES`, so the
runtime can operate apps it refuses by default, such as terminals and password
managers. ChatGPT reads the same setting. Turning computer use off leaves it
set; remove it with `defaults delete -g ComputerUseAllowForbiddenTargets`.

On Windows, the Codex runtime brings a window to the front to send it input.

## What agents get

The `js` tool runs the script in a separate process on the target machine, one
per agent, so each agent session starts fresh. The process runs with your user's
privileges, like the agent's own shell. Values the script stores on
`globalThis` stay available to that agent's next call. `js_reset` clears them,
and they also clear after 10 idle minutes. A script stops after 300 seconds.
Output is capped at about 25k tokens and 20 images per call.

`machine` picks the target machine. This release supports only the machine
running the agent.

Scripts use a Codex-style API: `cua.getApp('TextEdit')` binds an app's
window, and verbs such as `click(12)`, `typeText(...)` and `getAXState()` act
on it. Agents learn it from the `pane-computer-use` skill and from the `js`
tool's description. Under the API, Pane:

- shows only what changed in an app's tree since the agent's last read
  (added `+`, removed `-`, changed `~`), unless the agent asks for the full
  tree;
- waits for the app to settle after each action: 1 second, plus up to 5 more
  while it shows a spinner or progress indicator;
- keeps an element's id stable across diff reads of the same window. On the
  Codex runtime a full read renumbers the tree, so agents use ids from their
  latest read. On Cua Driver a control gets a new id when its label changes;
- runs calls to the same app one after another, so two agents never
  interleave keystrokes; calls to different apps run in parallel.

## Background and foreground

Pane never moves focus on its own. When an app can't take an action in the
background on your OS, the action fails with `needs_foreground`. When no
background route works, the agent may retry that one action with
`{ foreground: true }`. Pane first posts a notification ("Pane: *agent* is
bringing *App* to the front"), then brings the window forward. It does not wait
for you to respond. The same line appears in the agent's tool result.

## Apps Pane allows

Pane blocks no apps: password managers, terminals and system apps work like any
other. Turn computer use off on machines where agents should not touch the
desktop. The step screenshots record what each run did.

The skill tells agents to confirm with you before actions with outside effects
you didn't ask for, such as sending messages, payments, deleting data, or entering
personal data into a third-party site.

## Replays and pull requests

Every action records a step: the window screenshot after the app settles,
the action and its result. Steps are saved in the agent's Pane under
`~/.pane/artifacts/<session id>/computer-use/` (under `PANE_DIR` when set).
After each run, Pane rebuilds `replay.html` there. It is one offline page that
steps through every run in that Pane and opens as a tab in the Pane, without
taking focus. Runs started outside a Pane terminal leave no replay. Archiving
the Pane deletes these files, like its other artifacts.

Pane uploads nothing. When an agent opens a pull request, the skill tells it to
leave out frames that show secrets or unrelated windows, attach the rest, and
link the replay. On a public repository it asks you first.

The accessibility text and screenshots an agent reads go to its model provider,
like any other tool output.

## Turn it off

Switch it off in the same place, or run `runpane computer-use off`. A running
script stops, the engine exits, Pane removes the skill, and the next call
returns "Computer use is off on this machine. Turn it on in Pane's Remote
Access settings." On a Mac, `ComputerUseAllowForbiddenTargets` stays set (see
above).

## Limits in this release

- Only the machine running the agent. Other machines answer "Only this machine
  is supported yet."
- Dragging on macOS needs `{ foreground: true }`.
- `paste` handles plain text and Markdown, not HTML. When the clipboard holds
  something richer than text, `paste` types the text instead, so your
  clipboard is never lost.
- No live video, shared cursor or human takeover; screenshots and replays only.
