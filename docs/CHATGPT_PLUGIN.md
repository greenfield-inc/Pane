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

Ask in a chat, for example "Start a Codex agent in my web repo to fix the flaky login test." ChatGPT finds the repo with `repos_list` and starts the agent with `agents_start`. To open the panel, ask "Show the agents this chat started", or open **Chat agents** from the thread's tabs or the sidebar.

The panel refreshes every few seconds while it's visible:

- **Status** is what `agents_status` reports: Working, Ready, Needs input, Idle, Exited, Running (Pane can't classify the program), or Closed (the Pane was archived).
- **Send** submits your message to that agent with `agents_send`.
- **Open in Pane** brings Pane forward with that agent's Pane selected.

The panel also tells ChatGPT which agents it shows and their status, so you can refer to them in the chat.

## How the panel knows which agents a chat started

ChatGPT sends an anonymized chat id (`_meta["openai/session"]`) with every tool call. When `agents_start` runs, the server records the new Pane under that id in `~/.pane/chatgpt/chats.json` (inside `PANE_DIR` when set), keeping the latest 12 per chat. Agents started outside the chat, from Pane or the CLI, don't appear. Hosts that send no chat id share one list.

## For developers

- The plugin package is `plugins/pane/` (Agent Plugins 1.0.0 layout). `mcp.json` runs `node ./server/dist/cli.js mcp --toolsets core,chatgpt`.
- The `chatgpt` toolset lives in `packages/runpane/src/chatPanel.ts`. It serves `agents_panel` (thread and global entrypoints), `agents_panel_status` and `agents_panel_open` (visible only to the panel), and the `ui://pane/panel.html` resource.
- The panel's source is `packages/runpane/panel/` (React). `packages/runpane/scripts/build-panel.js` builds it into one self-contained `dist/panel.html`.
- The server uses `@modelcontextprotocol/server` 2 and writes the MCP Apps and OpenAI `_meta` keys by hand.
- Behavior tests: `pnpm test:runpane-mcp`.
