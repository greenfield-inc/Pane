# Pane for Claude

[Pane](https://runpane.com) is a free desktop app that runs coding agents (Claude Code, Codex and Cursor) side by side, each in its own git worktree and branch. This plugin lets Claude start those agents, check on them, send them follow-ups, open files beside them and ask you questions through Pane.

## Install

In Claude Code:

```text
/plugin install pane@claude-plugins-official
```

Or browse `/plugin` and pick **Pane**. In Claude Desktop and Cowork, open **Customize > Plugins**. Then install the Pane app from [runpane.com](https://runpane.com), open it, keep it running while you use the plugin, and restart your Claude session.

## What you get

- **Two skills.** `pane` teaches Claude how Pane works and how to reach it. `pane-manage-and-message-agents` covers starting, checking on and messaging another agent.
- **Pane's tools.** 33 tools: Pane's standard tools except the four that run commands and edit files on your other machines. They start an agent on a task and return a link to it, read its status and screen, send it a follow-up or answer its menu, open a page or file beside it, list and archive Panes, ask you a question through a Pane card and wait for your answer, and search Pane's docs. Tools that start, change or close something take `yes: true`; Claude is told to pass it only when you asked for that change, and without it Pane refuses the call.

## Try it

- "Start a Codex agent in Pane on my api repo to add rate limiting to the login route, and give me the link."
- "How are my Pane agents doing? Tell the one fixing login to add a test too."
- "Open docs/plan.html beside me in Pane."
- "Ask me through Pane whether to ship option A or B, and wait for my answer."

## Requirements

- The Pane app on the same machine, running. It is free; get it from [runpane.com](https://runpane.com).
- Node.js 22.23.4 or later on 22.x, 24.22.1 or later on 24.x, or 26.12.1 or later on 26.x, on your PATH, for `npx`.

Without the Pane app, the skills still load and each tool answers with an error that says to install Pane from runpane.com and restart the session. The `doctor` tool reports what is missing and, when it can reach Pane's release list, the download for your system.

## With the Pane app

Pane registers its own `pane` tools and skills with Claude Code. While this plugin is on, Pane removes its own copies when it starts, so Claude sees one set. Turn the plugin off and restart Pane to bring Pane's copies back. Claude sessions that Pane starts in its own terminal and chat tabs use the Pane app's built-in server instead of the plugin's. Codex and Cursor are not affected.

## What it runs, sends and fetches

- **Runs:** `npx -y runpane@<pinned version> mcp --toolsets plugin`, the `runpane` CLI from npm ([source](https://github.com/greenfield-inc/Pane/tree/main/packages/runpane)). When the Pane app installed a newer `runpane`, the pinned one hands each call to it, so the tools match your Pane version.
- **Sends:** tool calls go to the Pane app on the same machine, over a local socket. When a tool call fails, it sends a sanitized failure event to runpane.com: a random install id, the `runpane` and Pane versions, your OS and CPU type, the command name, and the error and exit codes. Routine status commands send nothing, and a repeating failure is sent at most once an hour. Set `DO_NOT_TRACK=1`, or turn off analytics in Pane, to stop it. The plugin sends nothing else: no code, prompts, conversations, file contents or account details. This covers the plugin; the Pane app's own analytics are described in the privacy policy below.
- **Fetches:** `npx` downloads the `runpane` package from the npm registry. `doctor` reads Pane's public release list to find the right download.

The privacy policy is at [runpane.com/privacy](https://runpane.com/privacy#claude-plugin).

## Notes for reviewers

- **No account.** Pane has no sign-in. To test, install Pane from [runpane.com](https://runpane.com) (macOS, Windows or Linux), open it, add any git repository, then try the prompts above.
- **Pinned server, newer tools.** The plugin pins one `runpane` release. With the Pane app installed, that release hands calls to the app's own newer `runpane`, so the tool list and server text come from your Pane release. Pane's CI checks every release for the policy points this plugin relies on: no catch-all tools in the `plugin` set, accurate read-only and destructive annotations, and server text that describes tools without steering the model.
- **`panels_input`** sends keys to another agent's terminal. It is how Pane answers an agent's menus; the server's instructions tell Claude to ask you before it answers a trust or permission prompt there.

## Support

Report problems at [github.com/greenfield-inc/Pane/issues](https://github.com/greenfield-inc/Pane/issues). Pane is open source under AGPL-3.0.
