# Agent discovery and communication

Pane uses one local daemon, its existing Unix socket (Windows named pipe), and
`sessions.db`. The `peers` commands add durable task messages to that control plane.
They work with any agent that can run a CLI, including agents outside Pane. Agent
labels are free text; adding a built-in launch preset is a separate integration.

## Discover and participate

```sh
runpane peers self --json
runpane peers list --json
runpane agent-context --command "peers send" --json
```

`self` reports identity, protocol version, capabilities, commands and the optional
Pi extension path. Managed terminals receive `PANE_PEER_ID`, `PANE_PANEL_ID` and
`PANE_AGENT_DISCOVERY`. The managed `AGENTS.md` block, Pane Chat guidance, CLI help
and command context expose the same protocol. An agent whose harness ignores
those surfaces needs the discovery command in its initial instructions.

Outside Pane, register an identity and use it on subsequent calls:

```sh
runpane peers register --peer reviewer-1 --agent-label my-agent --yes --json
runpane peers inbox --peer reviewer-1 --claim --limit 1 --yes --json
```

Alternatively set `PANE_PEER_ID=reviewer-1`. Use `--pane-dir` or `PANE_DIR` to select
the same daemon on both sides. WSL cannot use a Windows named pipe through its
Linux socket implementation: use the Windows wrapper from WSL, or a daemon inside
the distro. The existing remote transport remains separate; this protocol does
not discover arbitrary agents on other machines automatically.

Send a task with a stable, unique request id:

```sh
runpane peers send --to reviewer-1 --id issue-638-review-1 --input-file task.txt --yes --json
runpane peers wait --id issue-638-review-1 --follow --json
```

The recipient claims the task, performs it under its existing instructions, and
returns a concise result with artifact/commit/test references:

```sh
runpane peers reply --peer reviewer-1 --id issue-638-review-1 --status completed --text "Reviewed commit abc123; findings in review.md" --yes --json
```

Use `blocked` or `failed` when appropriate. After a blocked reply at revision 3,
wait again with `--after 3`. `--follow` suppresses timeout output and returns on
one meaningful reply; it does not poll a model. A disconnected daemon fails
visibly. Restart the wait with the same id and last observed revision.

Batch inbox/receipt/reply commands into existing tool work where possible. A
separate model turn to acknowledge a task can cost more than its compact payload.

## Receipts and recovery

| State | Evidence |
| --- | --- |
| `queued` | SQLite committed the message; recipient consumption is unconfirmed |
| `received` | Exactly one inbox claim committed; execution may not have started |
| `blocked` | Expected recipient reported a blocker for this message |
| `completed` / `failed` | Expected recipient returned an immutable task result |
| PR ready | Separate current-commit review, QA, CI and workflow evidence |

Reusing an id with identical sender, recipient and text returns the existing
receipt. Conflicting reuse is rejected. Replies from the wrong participant are
rejected. SQLite transactions commit before notifications. A reply arriving
before a wait is still visible; no subscribe-after-send race is required.

If a claim response is lost, inspect `peers inbox --include-received`. Received
tasks are never automatically claimed again. This prevents duplicate execution,
but it is not an exactly-once execution guarantee: a recipient can crash between
claim and execution. Reconcile its work before replying or explicitly assigning
a new task id. Terminal results remain durable across daemon restarts.

For an idle managed agent without a native receiver, `peers wake --id <id> --yes`
attempts one guarded inbox cue. It requires an observed empty agent composer,
records the attempt before writing, and reports consumption as unconfirmed. The
cue uses `peers inbox --id <id> --claim` so it consumes the requested task even
when an older task is also queued. It
does not send the task body as shell input. If the composer cannot be established,
inspect the panel and deliver an inbox instruction using the existing terminal
workflow. Never replay an uncertain write automatically.

Identity is a routing assertion inside Pane's existing local-user trust boundary,
not a new authentication credential. Processes with daemon access can already
control panels. Message content does not create an authorization grant. Tasks are
limited to 32 KiB, replies to 4 KiB, inbox reads to 100 rows, and simultaneous
long waits to 64. Task text appears only in inbox output; receipts omit it.
Rows are retained in the existing database, not silently evicted.

## Pi native delivery

Builds bundle a dependency-free Pi extension. `peers self` materializes it outside
Electron's archive and returns `piExtensionPath`. Launch Pi with that path:

```sh
pi -e /path/from/piExtensionPath
```

The extension uses the same daemon protocol and Pi's native `sendMessage`,
`ctx.isIdle()` and `agent_settled` APIs. It checks the required API surface, claims
one task at a time, and lets the agent explicitly reply. It does **not** complete
tasks on `turn_end` or `agent_settled`. A 5-second deterministic check costs no
model tokens. Native delivery leases expire after 120 seconds without bridge
registration; manual inbox reads cannot renew a native lease.

The adapter contract was checked against Pi source commit
[`71dca871`](https://github.com/earendil-works/pi/blob/71dca871bc80b6bc97be37f0ca3189399d651fff/packages/coding-agent/docs/extensions.md).
Automated adapter tests exercise native delivery, unrelated turn signals, lost
claim responses and shutdown races. A live authenticated Pi model session is a
separate integration check; do not infer support for every Pi release from these
contract tests. Older versions lacking the required API should use the CLI.

## Combine task waits with liveness

Keep the established cadenced watcher for uncorrelated work and failure signals.
For each panel with a cooperating recipient and a task wait, add
`--quiet-panel <panel-id>` to the usual `watch --follow` command. This suppresses
inferred READY/IDLE for that panel while retaining BLOCKED, held-input/STUCK and
exit signals. Other panels in the same pane keep their normal cadence.

Re-arm when the tracked panel set changes. Remove quieting when delivery remains
unconfirmed or cooperation stops. A quiet wait does not prove the agent is alive.
Overlapping explicit and observed blockers can produce duplicate notifications;
compare the task id/revision and current panel state before acting.

## What the Pi screenshot gets right

Armin Ronacher's `mitsuhiko/agent-stuff` extension implements local discovery,
messages and waits over Unix sockets without a separate service. It is an
optional extension, not a universal built-in Pi command or code by Pi's original
author. Its `message_processed` result means queued, and its `turn_end` wait
subscribes to the next tool/model round rather than a durable task identity.
See the [pinned extension](https://github.com/mitsuhiko/agent-stuff/blob/122e2994adddb113c04764c5697217dae120fcc6/extensions/control.ts).

Pane already had the socket architecture. The useful change is compact common
discovery, explicit receipts and task-correlated waits, while retaining Pane's
worktrees, lifecycle evidence and terminal fallback. Native Codex/Claude runtime
adapters can extend the same protocol later; existing interactive sessions are
not automatically attachable merely because those agents expose an SDK.

See [the token simulation](./AGENT_COMMUNICATION_SIMULATION.md) before choosing
which workstreams to migrate.
