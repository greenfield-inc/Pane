# Open in Pane links

An Open in Pane link puts a button on a web page, a README or a chat message that starts a coding agent on your prompt in [Pane](https://runpane.com). The person sees the prompt and presses **Start** before anything runs.

## The snippet

Paste one line where the button goes. Your page styles the link. The link goes to `https://runpane.com/open`, which opens Pane, or offers the download when Pane isn't installed.

```html
<a href="https://runpane.com/open?agent=claude&amp;prompt=Clone+github.com%2Facme%2Fapp+and+run+its+tests">Open in Pane with Claude</a>
```

```html
<a href="https://runpane.com/open?agent=codex&amp;prompt=Clone+github.com%2Facme%2Fapp+and+run+its+tests">Open in Pane with Codex</a>
```

A link without `agent` starts the person's default agent when it is installed, otherwise an agent that is:

```html
<a href="https://runpane.com/open?prompt=Clone+github.com%2Facme%2Fapp+and+run+its+tests">Open in Pane</a>
```

## Build a link

From a terminal:

```sh
runpane links create --prompt "Clone github.com/acme/app and run its tests" --agent claude --web
```

`--web` prints the `https://runpane.com/open` link, for web pages. Without it you get the `pane://new` link, which opens Pane directly from a terminal, a chat app or another desktop app. `--json` prints both (`url`, `webUrl`), the button as `html`, and the parsed `target`. Both forms encode the prompt for you. An agent builds the same link with the `links_create` MCP tool ([Pane MCP](PANE_MCP.md#docs-and-links)).

In Pane: open the Command Palette and choose **Create Open in Pane link…**. Type the prompt, pick the agent and where it runs, then copy the link, the web link or the HTML button.

## Parameters

| Parameter | Required | What it does | Limits |
| --- | --- | --- | --- |
| `prompt` | Yes | The text the agent receives. | At most 4000 characters. Tab and newline are allowed; control, text-direction and invisible characters (zero-width and tag characters, fillers, variation selectors other than an emoji's own) are refused. It must not start with `-`. Pane trims trailing spaces and shortens runs of blank lines to one. |
| `agent` | No | The agent to start: `claude`, `codex`, `cursor`, `opencode` or `pi`. | Leave it out for the person's default agent, or an installed agent when the default isn't installed. |
| `repo` | No | Starts the agent in a new Pane in that saved repository. | A repository id, its saved name, or `owner/repo`, matched against each saved repository's origin remote. |
| `session` | No | Sends the prompt to that existing Session's agent. `agent` does not apply. | The Session's id or name: one line, at most 100 characters. |

Without `repo` or `session`, the agent starts in a new Session. A link takes `repo` or `session`, not both.

Keep a web link at most 2,048 characters long, the most Chrome and Edge pass from a web page. `runpane links create --web` refuses a longer one. A `pane://new` link can be up to 16,384 characters once encoded.

## What the person sees

Pane comes to the front and shows a dialog:

- The title, such as "Start Claude on this prompt?", and where it runs: "Runs in a new Session.", "Runs in a new Pane in acme-app (acme/app)." (the saved name, then the `owner/repo` when they differ), or "Runs in Session Build fixes.".
- The prompt. A long one shows its first lines, with **Show all**.
- "Claude runs with full access: it can edit files and run commands without asking." Agents started from a link run with full access.
- When the link names an agent that isn't installed, a line says so, and an installed agent runs instead.
- When no agent Pane can start is installed, a line says which to install, and **Start** stays off. A link to an existing Session runs that Session's agent instead.
- **Options**, collapsed: change the agent (agents that aren't installed show "Not installed") or where it runs.
- **Cancel** and **Start**. Cancel has focus, and Enter and Escape cancel. Start turns on after a moment, so a stray click can't press it.

Nothing runs until the person presses **Start**. Pane then opens the new tab with the prompt sent.

## When Pane isn't installed

`https://runpane.com/open` opens Pane when it is installed. When it isn't, the page offers the download for the person's computer and a button that copies the prompt.

## Error messages

When Pane can't open a link, it says why in a dialog titled "Pane could not open this link". `runpane links open` prints the same message for problems found before the dialog asks (the first group below). It returns as soon as the dialog appears, so problems after **Start** (the last group) show only in Pane.

| Message | Cause |
| --- | --- |
| Pane link is too long | The `pane://new` link is over 16,384 characters. |
| Not a valid pane:// link | The text is not a URL. |
| Pane links look like pane://open?pane=&lt;id&gt; or pane://new?prompt=&lt;text&gt; | The link has another action, a path, a port, a user name or a `#` part. |
| Unknown pane link parameter: &lt;name&gt; | The link has a parameter other than `prompt`, `agent`, `repo` and `session`. |
| Repeated pane link parameter: &lt;name&gt; | A parameter appears twice. |
| A pane://new link names a repo or a session, not both | The link has `repo` and `session`. |
| A pane://new link names its repository as repo=&lt;id&gt;, repo=&lt;name&gt; or repo=&lt;owner/repo&gt; | `repo` has characters a repository name can't have. |
| A pane://new link names its Session as session=&lt;id&gt; or session=&lt;name&gt; | `session` is empty, over 100 characters, more than one line, or starts or ends with a space. |
| A pane://new link needs a prompt=&lt;text&gt; | The link has no `prompt`. |
| Pane won't send this link's prompt. The prompt holds control, text-direction or invisible characters, which Pane does not send to an agent. | The prompt has a character the dialog can't show. |
| Pane won't send this link's prompt. The prompt is empty. | The prompt is only spaces and blank lines. |
| Pane won't send this link's prompt. The prompt is longer than 4000 characters. | The prompt is too long. |
| Pane won't send this link's prompt. The prompt starts with "-", which an agent would read as an option. | The prompt starts with `-`. |
| Unknown agent in pane link: &lt;id&gt;. Use one of &lt;agent ids&gt;, or leave agent out for the person's default. | `agent` is not an agent Pane knows. |
| No saved repository matches "&lt;repo&gt;". Add it to Pane (Add Repository, or `runpane repos add --path <path>`), then open the link again. | The person hasn't added that repository to Pane. |
| Several saved repositories match "&lt;repo&gt;" (&lt;names&gt;). Use the numeric id from `runpane repos list` in the link. | `repo` matches more than one saved repository. |
| No Session matches "&lt;session&gt;". Use a Session's name or id from `runpane sessions list`, or leave session out to start a new Session. | No Session has that id or name. |
| Session "&lt;name&gt;" is archived. Restore it in Pane, then open the link again. | The Session is archived. |
| Several Sessions are named "&lt;session&gt;". Use the Session's id from `runpane sessions list` in the link. | More than one Session has that name. |
| Session "&lt;name&gt;" has no &lt;agent&gt; tab to send the prompt to. | The Session's agent tab is gone. |
| Pane is already asking about another start link. Answer that one, then open this link again. | A start dialog is already open. |

After **Start**, in Pane only:

| Message | Cause |
| --- | --- |
| &lt;Agent&gt; is not running in &lt;where&gt;'s tab, so the link's prompt was not sent. Start &lt;agent&gt; in that tab (or install it), then open the link again. | The Session's tab has a shell or another program, not its agent. Pane never types a link's prompt into a shell. |
| &lt;where&gt;'s &lt;agent&gt; is stopped at a prompt in its tab, so the link's prompt was not sent. Answer it there, then open the link again. | The agent is waiting on a question, such as trusting a folder. |
| Pane could not start the linked task in &lt;where&gt;: &lt;reason&gt; | Creating the Pane or Session failed after Start. |
| Pane could not confirm that &lt;where&gt; got the prompt. Open the Session to check whether it arrived. | The prompt went to an existing Session, and Pane could not confirm it arrived. |
