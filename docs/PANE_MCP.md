# Pane MCP Server

`runpane mcp` is an MCP server that gives coding agents Pane's `runpane` commands as tools. With it, an agent in any repository can list saved repositories, create Panes, open panels, read terminal screens, and send input, with no instructions file in the repo.

## Automatic registration

The Pane desktop app registers the server for you. On launch, Pane adds a `pane` MCP server to your user-level config:

- **Claude Code**: via `claude mcp add pane --scope user …`, which writes `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`).
- **Codex**: a `[mcp_servers.pane]` table in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`).

Pane registers only with the CLIs that are installed, and it manages only the entry it wrote:

- It leaves other MCP servers and settings alone and never writes a second `pane` entry.
- It rewrites its own entry when the app moves or updates.
- A `pane` entry you added yourself (for example with `npx runpane mcp`) is left untouched, including when you turn the setting off. For Claude Code, Pane's entry is the one that runs `<Pane data dir>/mcp/runpane/dist/cli.js`. For Codex, it's the `[mcp_servers.pane]` table carrying the `# Managed by Pane` comment.
- Pane edits `config.toml` as text, so your comments and formatting survive. It then parses the result and writes nothing unless the only change is Pane's own entry. Writes are atomic and follow a symlinked config.

On Windows, Pane also registers inside each WSL distro that has a saved WSL repository. Agents there run the Windows Pane binary through WSL interop.

The registered command is the Pane executable in Node mode (`ELECTRON_RUN_AS_NODE=1`) running a copy of the runpane CLI at `<Pane data dir>/mcp/runpane/dist/cli.js`. No Node.js or npm install is needed. Only packaged builds register; a development build never touches your agent config.

To turn this off, open **Settings → AI & Agents** and switch off **Register Pane tools with Claude Code and Codex**. Pane then removes its entry from each config.

Restart a running `claude` or `codex` session to pick up a new registration. Check it with `claude mcp list` or `codex mcp list`.

## Toolsets

A server that offers dozens of tools makes models, especially smaller ones, worse at choosing the right one. So by default the server serves a lean `core` toolset, and everything else is opt-in:

| Toolset | Tools |
|---|---|
| `core` (default) | `agents_start`, `agents_status`, `agents_send`, `panels_input` (exact keys, for menus and prompts), `repos_list`, `repos_add`, `panes_list`, `workspace_state`, `panes_git_status`, `panes_archive`, `panes_restore`, `links_create`, `docs_search`, `docs_read`, `doctor` |
| `agents` | the three agent tasks, `workspace_state`, `watch` |
| `panes` | create, adopt, list, archive, restore, pin, unpin, rename, focus, cost, run and stop the run script, move to a folder, `folders_list`, `folders_create` |
| `panels` | create, list, output, screen, input, submit, submit-composer, wait |
| `git` | status, commit, push, pull, fetch, rebase onto main, squash-rebase onto main, stash, stash-pop, soft reset (`panes_*`) |
| `sessions` | the eight `sessions_*` tools |
| `repos`, `docs`, `links`, `admin` | repository, documentation, deep-link, and diagnostic tools |
| `all` / `read` | every tool / every read-only tool |

Choose with `runpane mcp --toolsets core,git` (comma-separated). `--read-only` keeps only read-only tools from whatever is selected. The Pane app registers `core` by default; **Settings → AI & Agents → Pane tools to register** switches it to `all`. Each command's toolsets live in the contract's `toolsets` field.

## The three agent jobs

The core set is built around the three jobs agents most often need, each finished in one call:

- `agents_start`: creates a Pane in a repository, starts the agent with the task, waits until it is ready, and returns the pane and panel ids and a `pane://` link.
- `agents_status`: whether the agent is working, ready, blocked (waiting on a person), idle, or exited, plus its current screen.
- `agents_send`: submits a follow-up and reports whether Pane saw it leave the composer.

## Docs and links

`docs_search` searches Pane's docs, `runpane` help, per-command context, and the Pane Chat skills installed in the Pane data directory. It returns short excerpts with paths. `docs_read` returns one path in full. Both work offline, and the same docs are listed as `runpane-docs:` MCP resources.

`links_create` builds `pane://open?pane=<id>[&panel=<id>]`, `pane://open?repo=<id>`, or `pane://open?session=<id>`. Pane registers the `pane://` scheme on macOS, Windows, and Linux. Opening a link (from a browser, a terminal, or `links_open`) raises Pane and selects what it names. It never changes Pane state, and a link with any unexpected part is rejected.

## Registering by hand

Without the desktop app, or for another MCP client, run the server from npm: `npx --yes runpane@latest mcp`. Add `--toolsets <names>` to choose tools.

```bash
claude mcp add --scope user pane -- npx --yes runpane@latest mcp
codex mcp add pane -- npx --yes runpane@latest mcp
```

Cursor (`~/.cursor/mcp.json`):

```json
{ "mcpServers": { "pane": { "command": "npx", "args": ["--yes", "runpane@latest", "mcp"] } } }
```

VS Code (`.vscode/mcp.json`, or run **MCP: Add Server**):

```json
{ "servers": { "pane": { "type": "stdio", "command": "npx", "args": ["--yes", "runpane@latest", "mcp"] } } }
```

Any other client that can launch a stdio server uses the same command and arguments.

The server is stdio only: it runs next to the Pane app on the same machine, so there is no HTTP transport and no OAuth. To drive a remote Pane, run the server on the remote host.

The Python package (`pipx run runpane`) does not include the MCP server, the docs search, or the agent tasks, because they need Node. From Python, those commands print the npm command and exit with status 2.

## Manual test steps

Automated tests cover the registration and link logic on every OS. Check these by hand on a packaged build of each platform.

**macOS, Windows, and Linux**

1. Install and launch Pane, with Claude Code and Codex installed.
2. Run `claude mcp list` and `codex mcp list`. Each shows `pane` as connected.
3. In a fresh `claude` session, ask "Use Pane to list my repos". It calls `repos_list`.
4. Quit and relaunch Pane. The Claude and Codex configs are unchanged.
5. Turn off **Settings → AI & Agents → Register Pane tools with Claude Code and Codex**. `pane` is gone from both lists, and the other entries are unchanged.

**pane:// links**

1. Get a link: `runpane links create --pane <pane-id>`.
2. With Pane running, open it from a browser or a terminal:
   - macOS: `open "pane://open?pane=<pane-id>"`
   - Windows: `start "" "pane://open?pane=<pane-id>"`
   - Linux: `xdg-open "pane://open?pane=<pane-id>"`
3. Pane comes to the front on that Pane, and no second Pane window opens. On Windows and Linux, the extra process hands the link to the running Pane and exits.
4. Quit Pane and open the link again. Pane starts and opens that Pane.
5. Open `pane://open?pane=<pane-id>&archive=1`. Pane logs `Unknown pane link parameter: archive` and changes nothing.
6. On Linux, check the handler: `xdg-mime query default x-scheme-handler/pane` names Pane's desktop file (AppImage and .deb).

**Windows with WSL**

1. Save a repository that lives in a WSL distro, with Claude Code and Codex installed inside that distro.
2. Relaunch Pane. Inside the distro, `claude mcp list` and `codex mcp list` show `pane`, whose command is `/mnt/c/.../Pane.exe`.
3. From a `claude` session inside the distro, ask "Use Pane to list my repos". The call reaches the Windows Pane.
4. Turn the setting off. `pane` is gone from the distro's configs too.

## Example prompts

- "Use Pane to start Claude on fixing the login redirect in the web repo, and give me a link to watch it."
- "How is the agent in my fix-login Pane doing? Does it need anything from me?"
- "Tell the fix-login agent to also add a test for the redirect."
- "Which of my Panes have uncommitted or unpushed work?"
- "How do I archive a Pane and get it back later? Check Pane's docs."

## Not supported

- Streaming. `watch --follow` isn't offered; use `agents_status`, or `watch` with `timeoutMs`.
- App settings. Agents can't read or change Pane's settings.
- Permanently deleting Panes or removing repositories. Those stay in the app, where the user sees what goes.
- Progress notifications and pagination (the full list is small).
- Code or scripts run inside the MCP server itself. Agents run code in Pane terminals through `agents_start` and `agents_send`.

## Protocol

The server uses the MCP TypeScript SDK v2 over stdio. It speaks MCP revision 2026-07-28, which has no handshake: `server/discover`, with the version and client capabilities carried on each request. It also accepts the 2025 `initialize` handshake that current Claude Code and Codex releases send, negotiating down to 2025-11-25.

Only JSON-RPC goes to stdout, and the server exits when stdin closes. Cancelling a call (`notifications/cancelled`) stops the `runpane` process running it.

## Tools

Tools are generated from [`contracts/runpane/contract.json`](../contracts/runpane/contract.json) when the server starts:

- Every command that has result `jsonSchemas` becomes a tool. Spaces and hyphens in the name become underscores: `repos list` → `repos_list`, `panels submit-composer` → `panels_submit_composer`.
- The tool's inputs are the flags from the command's `usage` lines and its `agentContext` arguments, in camelCase (`--timeout-ms` → `timeoutMs`). Flags that take a value are strings; flags without one are booleans. Daemon commands also accept `paneDir`.
- The description combines the command's summary, details, and notes from `agentContext`. The title is `runpane <command>`.
- The output schema is the command's `*Result` JSON schema. Every call runs `runpane <command> … --json` and returns its JSON output unchanged, both as `structuredContent` and as a text block for older clients.
- A non-zero exit returns the output as a tool error (`isError: true`), and so do bad arguments, so the model can correct them. An unknown tool name is a JSON-RPC Invalid Params error (`-32602`).
- Annotations come from the contract. `readOnlyHint` is the inverse of `mutates`. A mutating tool is `destructiveHint: true` unless the command is marked `additive`. `idempotentHint` and `openWorldHint` follow the `idempotent` and `openWorld` fields.
- Values are passed as `--flag=value`, so a value may start with `-` (for example `- [ ] item`).

Adding or changing a command in the contract changes its tool. There is no per-tool code.

A few flags are left out. `--json` is always passed. `--follow` is omitted because a streaming watch cannot return a single result; call `watch` with `timeoutMs` instead. Tools have no stdin, so pass exact terminal bytes in `text` (for example `\u0003` for Ctrl-C) rather than `inputFile: "-"`.

## Confirmation

Mutating tools keep the CLI's confirmation rule. Every command whose usage includes `--yes` gets a `yes` input. Without `yes: true`, the call fails with the CLI's own refusal and changes nothing. Tools are also annotated with `readOnlyHint`, so clients can auto-approve read-only tools and prompt for the rest.

## AGENTS.md block

Before the MCP server, Pane wrote a managed `<!-- pane-agent-context -->` block into each active repository's `AGENTS.md`. Pane no longer writes it by default. Existing blocks stay where they are, because deleting committed text from your repositories without asking would be a surprise. To remove them, turn **Publish Pane instructions to AGENTS.md** on and then off. Turning it off removes the block from every saved repository and logs each file it changed. To keep the block for agents that don't use MCP, leave that setting on.
