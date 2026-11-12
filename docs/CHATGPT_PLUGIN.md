# ChatGPT desktop plugin

The Pane plugin lets ChatGPT start, check on, and message the coding agents Pane runs on your Mac. It adds a **Chat agents** panel beside the chat that lists the agents that chat started, with live status, a message box, and **Open in Pane**.

The plugin works only in the ChatGPT desktop app. It runs its own copy of `runpane mcp` over stdio on your machine, and ChatGPT's servers can't reach a local server, so it can't be listed in ChatGPT's plugin directory.

## Install

You need the Pane desktop app running, the ChatGPT desktop app, Node.js 20 or later on your `PATH`, and a clone of this repository.

1. Build the plugin's server. This copies the `runpane` CLI into `plugins/pane/server/`:
   ```bash
   pnpm install
   pnpm build:chatgpt-plugin
   ```
2. Add the repository's marketplace (`.agents/plugins/marketplace.json`). ChatGPT desktop and Codex share this setting:
   ```bash
   codex plugin marketplace add /path/to/Pane
   ```
3. Restart the ChatGPT desktop app, open **Plugins**, and install **Pane** from the **Pane** marketplace. From a terminal, `codex plugin add pane@pane` installs the same plugin for Codex.

After pulling changes to the plugin, rebuild, then reinstall it, because ChatGPT loads the installed copy from `~/.codex/plugins/cache/pane/pane/`.

## Use it

Ask in a chat, for example "Start a Codex agent in my web repo to fix the flaky login test." ChatGPT finds the repo with `repos_list` and starts the agent with `agents_start`.

**Inline cards.** When ChatGPT starts an agent, checks on it or messages it, the result shows as a Pane card in the chat. The card is the agent's row from Pane's sidebar with its last terminal lines. It shows the status dot, the branch icon (a PR icon once there's a pull request), `#PR`, and `+adds -dels`. It also has **Open in Pane**, plus **PR #n** when there is one. A card keeps updating for 10 minutes while its agent works or waits on you.

**The Chat agents panel.** Open **Chat agents** from the thread's tabs or the sidebar, or ask "Show the agents this chat started." The panel looks like Pane's sidebar. The agents this chat started are grouped by repo, and the selected agent shows its terminal, a message box and **Open in Pane**. It refreshes every 4 seconds while visible, and it opens on the agent that needs you. Ask "Show me the billing agent" and ChatGPT selects that agent in the panel with `agents_panel_focus`. The panel also tells ChatGPT which agent you're looking at.

Status follows Pane's own indicators:

| Indicator | Word | Meaning |
| --- | --- | --- |
| Blue spinner | working | The agent is busy. |
| Pulsing red dot | needs you | The agent waits on a question or permission prompt. |
| Blue dot, dashed title | ready | The agent finished a turn you haven't looked at. |
| Green dot | idle | The agent is idle. |
| Gray dot | exited | The agent's process exited. |
| No dot | shell | Pane can't classify the program, for example a plain shell. |
| No dot | archived | The Pane was archived. |

**Send** delivers your message to that agent's terminal. **Open in Pane** brings Pane forward with that Pane selected. If Pane isn't running, the cards and the panel say so.

## What the plugin stores

ChatGPT sends an anonymized chat id (`_meta["openai/session"]`) with each tool call. When `agents_start` runs, the server adds the new Pane's id under that chat id in `~/.pane/chatgpt/chats.json` (inside `PANE_DIR` when set), keeping the latest 12 per chat. Pane has no other record of which chat started a Pane, so this one mapping is stored. Everything else comes from Pane on each refresh: name, repo, agent panel, status, terminal, PR and diff. The agent the model last selected is kept in memory only. Agents started outside the chat, from Pane or the CLI, don't appear. Hosts that send no chat id share one list.

## For developers

- The plugin package is `plugins/pane/` (Agent Plugins 1.0.0 layout). `mcp.json` runs `node ./server/dist/cli.js mcp --toolsets core,chatgpt`.
- The `chatgpt` toolset lives in `packages/runpane/src/chatPanel.ts`. It adds these tools:
  - `agents_panel`, with thread and global entrypoints.
  - `agents_panel_focus`, visible to the model.
  - `agents_panel_status`, `agents_card` and `agents_panel_open`, visible only to the widgets.

  It also serves the `ui://pane/panel.html` resource. With the toolset on, `agents_start`, `agents_status` and `agents_send` render inline cards from the same resource.
- The widget source is `packages/runpane/panel/` (React and lucide icons). `packages/runpane/scripts/build-panel.js` bundles it with esbuild into one self-contained `dist/panel.html`. `docs/chatgpt-plugin/feel.md` records which Pane primitives it ports and why it uses ChatGPT's system font and colors.
- The server uses `@modelcontextprotocol/server` 2 and writes the MCP Apps and OpenAI `_meta` keys by hand.
- Behavior tests: `pnpm test:runpane-mcp`.
