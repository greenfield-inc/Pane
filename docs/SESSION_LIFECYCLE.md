# Session commands and terminal lifecycle

Session-level Claude commands (`sessions:input`, `sessions:continue`, queued
creation/input, and rebase assistance) use persisted terminal panels. They share
TerminalPanelManager's PTY ownership, output persistence, readiness, and resume
behavior with the regular panel UI. A session command selects the active Claude
panel, then a live Claude panel, then an existing Claude panel. It never reuses an
ordinary shell or another agent's terminal. A live Claude terminal created by
the regular panel UI must be used directly or stopped before session commands
can take ownership. Explicit starts create a new Claude panel; continuation
reuses the selected conversation.

Session-owned terminals launch structured arguments through a noninteractive
shell that exits with Claude. The shell cannot remain open to interpret a later
prompt after `/exit` or a failed launch. Readiness callbacks belong to that exact
live process and cannot deliver input to its replacement. Initialization is
serialized per panel, including concurrent renderer requests.

Panel-local conversation IDs take precedence. When an older session has no
Claude panel, continuation carries its stored `claude_session_id` into the new
panel. Existing session outputs, conversation messages, and database migrations
remain available for history and export. Claude resume preserves the configured
permission mode, model, configured global/project instructions, and inherited
MCP tools. Approval runs in Claude's native terminal UI; `auto` uses Claude's
default model. Session busy state follows the aggregate state of its owned
agents, so one panel finishing does not mark another running panel stopped.

Session stop shares the launch lock and stops every terminal in the session,
plus any processes still owned by the legacy CLI manager. It retains panels and
history for later reopening and does not stop another session's processes. Stop
awaits terminal state persistence before a continuation may update the panel.

The optional Redis queue remains supported through `REDIS_URL`; without it the
in-process queue is used. Both Redis connection configurations retain completed
job cleanup and failed-job retention. Logs describe the backend without printing
connection URLs or credentials.

The supported Node/Electron runtimes supply Web Streams and `crypto.randomUUID`
natively. No startup polyfill or direct UUID package is required; any transitive
copies remain governed by the lockfile and existing supply-chain policy.
