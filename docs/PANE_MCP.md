# Pane MCP Server

`runpane mcp` is an MCP server that gives coding agents Pane's `runpane` commands as tools. With it, an agent in any repository can list saved repositories, create Panes, open panels, read terminal screens, and send input, with no instructions file in the repo.

## Automatic registration

The Pane desktop app registers the server for you. On launch, Pane adds a `pane` MCP server to your user-level config:

- **Claude Code**: via `claude mcp add pane --scope user …`, which writes `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`).
- **Codex**: a `[mcp_servers.pane]` table in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`).

Pane registers only with the CLIs that are installed. It leaves other MCP servers and settings alone, never writes a second `pane` entry, and rewrites its own entry when the app moves or updates. On Windows, Pane also registers inside each WSL distro that has a saved WSL repository. Agents there run the Windows Pane binary through WSL interop.

The registered command is the Pane executable in Node mode (`ELECTRON_RUN_AS_NODE=1`) running a copy of the runpane CLI at `<Pane data dir>/mcp/runpane/dist/cli.js`. No Node.js or npm install is needed. Only packaged builds register; a development build never touches your agent config.

To turn this off, open **Settings → AI & Agents** and switch off **Register Pane tools with Claude Code and Codex**. Pane then removes its entry from each config.

Restart a running `claude` or `codex` session to pick up a new registration. Check it with `claude mcp list` or `codex mcp list`.

## Registering by hand

Without the desktop app, or for another MCP client, run the server from npm:

```bash
claude mcp add --scope user pane -- npx --yes runpane@latest mcp
codex mcp add pane -- npx --yes runpane@latest mcp
```

Any MCP client that can launch a stdio server can use the same command: `npx --yes runpane@latest mcp`.

The Python package (`pipx run runpane`) does not include the MCP server, because it needs the Node MCP SDK. `runpane mcp` from Python prints the npm command and exits with status 2.

## Tools

Tools are generated from [`contracts/runpane/contract.json`](../contracts/runpane/contract.json) when the server starts:

- Every command that has result `jsonSchemas` becomes a tool. Spaces and hyphens in the name become underscores: `repos list` → `repos_list`, `panels submit-composer` → `panels_submit_composer`.
- The tool's inputs are the flags from the command's `usage` lines and its `agentContext` arguments, in camelCase (`--timeout-ms` → `timeoutMs`). Flags that take a value are strings; flags without one are booleans. Daemon commands also accept `paneDir`.
- The description combines the command's summary, details, and notes from `agentContext`.
- Every call runs `runpane <command> … --json` and returns its JSON output unchanged. A non-zero exit returns the output as a tool error.

Adding or changing a command in the contract changes its tool. There is no per-tool code.

A few flags are left out. `--json` is always passed. `--follow` is omitted because a streaming watch cannot return a single result; call `watch` with `timeoutMs` instead. Tools have no stdin, so pass exact terminal bytes in `text` (for example `\u0003` for Ctrl-C) rather than `inputFile: "-"`.

## Confirmation

Mutating tools keep the CLI's confirmation rule. Every command whose usage includes `--yes` gets a `yes` input. Without `yes: true`, the call fails with the CLI's own refusal and changes nothing. Tools are also annotated with `readOnlyHint`, so clients can auto-approve read-only tools and prompt for the rest.

## AGENTS.md block

Before the MCP server, Pane wrote a managed `<!-- pane-agent-context -->` block into each active repository's `AGENTS.md`. Pane no longer writes it by default. Existing blocks stay where they are, because deleting committed text from your repositories without asking would be a surprise. To remove them, turn **Publish Pane instructions to AGENTS.md** on and then off. Turning it off removes the block from every saved repository and logs each file it changed. To keep the block for agents that don't use MCP, leave that setting on.
