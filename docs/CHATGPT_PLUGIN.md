# ChatGPT desktop plugin

The Pane plugin lets ChatGPT start, check on, and message the coding agents Pane runs on your Mac, and tell you what waits on you in Pane. It adds a **Chat agents** panel beside the chat that lists the agents that chat started, with live status, a message box, and **Open in Pane**.

The plugin works only in the ChatGPT desktop app, in a **Local** Work thread. It runs its own copy of `runpane mcp` over stdio on your machine. OpenAI lists desktop-only plugins like this one in its directory only for partners it has approved, so you install it from this repository.

## Install

You need the Pane desktop app running, the ChatGPT desktop app, Node.js 22.23.4, 24.22.1 or 26.12.1 or later on your `PATH`, and a clone of this repository.

1. Build the plugin's server. This copies the `runpane` CLI into `plugins/pane/server/`:
   ```bash
   pnpm install
   pnpm build:chatgpt-plugin
   ```
2. Add the repository's marketplace (`.agents/plugins/marketplace.json`). ChatGPT desktop and Codex share this setting:
   ```bash
   codex plugin marketplace add /path/to/Pane
   ```
3. Restart the ChatGPT desktop app, open **Plugins**, and install **Pane** from the **Pane** marketplace. Use it in a **Local** Work thread. From a terminal, `codex plugin add pane@pane` installs the same plugin for Codex.

After pulling changes to the plugin, rebuild, then reinstall it, because ChatGPT loads the installed copy from `~/.codex/plugins/cache/pane/pane/`.

## Use it

Ask in a chat, for example "Start a Codex agent in my web repo to fix the flaky login test." ChatGPT finds the repo with `repos_list` and starts the agent with `agents_start`. Later work on the same branch, such as "have a Claude agent review that fix", opens as a new tab in that agent's Pane (`agents_start` with `pane`), and gets its own card. Ask for a chat tab ("open Claude as a chat tab in that Pane") and ChatGPT opens one with `panels_create` and `chat: true`; it gets a card too. Chat tabs need **Settings → AI & Agents → Chat tabs** on in Pane.

**What waits on you.** Ask "What does Pane need from me?" ChatGPT reads, and never answers:
- `autopilot_waiting`: every approval and question waiting on you, on every machine, grouped by Session. It needs Autopilot on (Settings › Advanced › Experimental); `autopilot_status` says whether it is, and `autopilot_stack` lists what Autopilot put in front of you.
- `inbox`: one Session's worker reports and blocked agents. `sessions_list` finds the Session and `sessions_overview` shows its Panes, agents and PRs.

You answer approvals in Pane or on your phone. Pane lets only Autopilot answer for you, so ChatGPT has no tool that answers, closes or rewrites an approval.

**Prompts stay yours.** When an agent shows a permission, trust or question prompt in its terminal (status **needs you**), the panel's message box is disabled, and `agents_send` refuses, since typing a message into a prompt answers it. Open the agent in Pane and answer there. A worker that reported blocked with a question is at its message box, so you can answer it from the chat.

**Archive.** `panes_archive` keeps Pane's safety check: it refuses when uncommitted, unpushed or unsent work would be lost, or an agent is mid-turn. ChatGPT tells you what it flagged and archives anyway only if you agree. `panes_restore` undoes an archive.

**Inline cards.** When ChatGPT starts an agent, checks on it or messages it, the result shows as a Pane card in the chat. The card is the agent's row from Pane's sidebar with its last terminal lines. It shows the status dot, the branch icon (a PR icon once there's a pull request), `#PR`, `+adds -dels`, and the agent's latest `runpane report` (its question when it reports blocked, else its summary). It also has **Open in Pane**, plus **PR #n** when there is one. A card keeps updating for 10 minutes while its agent works or waits on you.

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

**Send** delivers your message to that agent's terminal or chat tab. **Open in Pane** brings Pane forward with that Pane selected. If Pane isn't running, the cards and the panel say so.

## What the plugin stores

ChatGPT sends an anonymized chat id (`_meta["openai/session"]`) with each tool call. When `agents_start` or `panels_create` runs, the server adds the new agent's Pane and panel ids under that chat id in `~/.pane/chatgpt/chats.json` (inside `PANE_DIR` when set), keeping the latest 12 per chat. Pane has no other record of which chat started an agent, so this one mapping is stored. Everything else comes from Pane on each refresh: name, repo, status, terminal, report, PR and diff. The agent the model last selected is kept in memory only. Agents started outside the chat, from Pane or the CLI, don't appear. Hosts that send no chat id share one list.

## For developers

- The plugin package is `plugins/pane/` (Agent Plugins 1.0.0 layout). `mcp.json` runs `node ./server/dist/cli.js mcp --toolsets chatgpt`.
- The `chatgpt` toolset serves the 21 contract commands tagged `chatgpt` in `contracts/runpane/contract.json`: starting, checking on and messaging agents, chat tabs (`panels_create`), repos, Panes, git status, links, docs, `doctor`, and the reads of Autopilot, Session inboxes and Sessions. It leaves out `panels_input` (raw keys answer prompts) and every command that answers an approval. `packages/runpane/src/chatPanel.ts` gives the toolset its own server instructions and adds ChatGPT notes to five contract tools' descriptions. It refuses `agents_send` while the target tab's workspace state is `agent.blocked`. It also adds these tools:
  - `agents_panel`, with thread and global entrypoints.
  - `agents_panel_focus`, visible to the model.
  - `agents_panel_status`, `agents_card` and `agents_panel_open`, visible only to the widgets.

  It also serves the `ui://pane/panel.html` resource. With the toolset on, `agents_start`, `agents_status`, `agents_send` and `panels_create` render inline cards from the same resource.
- The widget source is `packages/runpane/panel/` (React and lucide icons). `packages/runpane/scripts/build-panel.js` bundles it with esbuild into one self-contained `dist/panel.html`. `docs/chatgpt-plugin/feel.md` records which Pane primitives it ports and why it uses ChatGPT's system font and colors.
- The server uses `@modelcontextprotocol/server` 2 and writes the MCP Apps and OpenAI `_meta` keys by hand.
- Behavior tests: `pnpm test:runpane-mcp`.
