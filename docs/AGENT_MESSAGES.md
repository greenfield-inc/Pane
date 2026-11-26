# Agent-to-agent messages

When one agent's tab sends another agent's tab a message through Pane, the
receiver needs a way to answer that the sender will see. An answer typed only in
the receiver's own chat never reaches the sender. So Pane gives each such
message an id, `M-n`, and ends it with a reply line. The receiver answers with
`runpane reply`, and Pane types that answer into the sender's tab. To-dos already
work this way through `runpane todos comment`. Messages reuse the same delivery
path.

## What counts as an agent's message

`runpane panels submit` (which `agents send`, Session-to-Session messages and
Autopilot's `[From Autopilot]` lines all go through) records a message when all
of these hold:

- the request comes from a Pane tab: the CLI or MCP server sends the caller's
  `PANE_PANEL_ID` with every daemon request, and Pane's UI, phone and glasses
  send none;
- that tab runs an agent: a chat tab, or a terminal tab Pane knows an agent in.
  Someone typing `runpane panels submit` in a plain shell tab is the person;
- it isn't `--source user`, and it isn't a tab writing to itself;
- it isn't one of Pane's own lines. Owed answers, to-do messages and replies set
  `fromPane` on the submit and go as typed.

When those hold, Pane adds one line to the end of the text:

```text
Reply with runpane reply M-12 "…": it reaches the "Omni Chat" Session orchestrator, who never sees your own chat.
```

The submit result carries `messageId: "M-12"`. If the submit fails, or sends
nothing (`blocked`), the message is recorded as `undelivered` with the reason.

## Replying

```sh
runpane reply M-12 "Yes: the API is frozen until Friday."
runpane reply M-12 --input-file answer.md
```

The pane MCP server has the same command as its `reply` tool, in the core
toolset. A reply can be up to 8,000 characters. Pane records it as message `M-13`
(`kind: reply`, `replyTo: M-12`) and marks M-12 `answered`. Then it types this
into the original sender's tab:

```text
reply: M-12 → "Yes: the API is frozen until Friday." (from the "Billing" Session orchestrator) [M-13; answer it with runpane reply M-13 "…"]
```

Delivery reuses the path that to-do messages and owed answers take
(`typeIntoLocalTab`):

- Pane types the reply only at a live agent's prompt. A tab that is mid-turn,
  or that has unsent text in its composer, keeps the reply `queued`. Pane tries
  again when any tab goes idle, and every 3 seconds.
- A tab that is down (after a restart, say) is resumed first. After 3 failed
  resumes the reply is `undelivered` (`it would not restart`).
- A reply to a Session orchestrator follows the Session. If the orchestrator's
  tab was replaced (Switch to chat, a new agent), the reply goes to the
  Session's orchestrator tab as it is now.
- A sender whose tab is gone for good (a closed worker tab) gets nothing, and
  the reply is `undelivered` (`its tab closed`). `runpane reply` exits 1 and
  says so. Pass the answer on some other way.
- Queued replies are kept in the database, so they survive a restart of Pane.

Messages work only between tabs on the same computer. A `panels submit` routed
to another machine (`runpane workspace <machine> …`) goes as typed.

## Waiting for the reply

```sh
runpane panels submit --panel <id> --text "Is the API frozen?" --await-reply --timeout 30m --yes --json
runpane messages wait M-12 --timeout 30m --json
```

Both block until the first reply comes and print it (`messageWaitResult`, exit
0). After `--timeout` they exit 124, and a later reply is typed into the tab as
usual. A reply that a waiting call returns is not typed as well: it is
`delivered` with `deliveredVia: call`. Without `--timeout`, the wait gives up
after a day. While a tab waits, Pane counts it as waiting rather than working,
as it does for `runpane notify`. `--await-reply` can't be combined with
`--wait`.

## Reading messages

`runpane messages list` lists the calling tab's messages, sent and received,
newest first. `--panel <id>` picks another tab, `--all` lists every message on
this computer, and `--limit` caps the count (default 50).
`runpane messages show M-12` shows one message and its replies.

## The record

`shared/types/agentMessages.ts` defines `AgentMessageRecord`. The JSON schema
`agentMessage` in `contracts/runpane/contract.json` describes the same shape:

| Field | Meaning |
| --- | --- |
| `ref`, `number` | `M-12`, `12`. Never handed out twice on a computer. |
| `kind` | `message`, or `reply` |
| `replyTo` | The message a reply answers (`M-12`); `null` for a message |
| `sender`, `receiver` | `{ panelId, paneId, sessionId, name, orchestrator }`. `name` is what Pane shows ("the "Omni Chat" Session orchestrator", a Pane's name, or "the person" for a reply typed outside any tab). |
| `text` | The sender's text, without the reply line Pane added |
| `state` | `sending` (being typed), `delivered`, `answered` (a message with a reply), `queued` (a reply waiting for its tab), `undelivered` |
| `deliveredVia` | For a delivered reply: `tab` (typed) or `call` (returned to `--await-reply`) |
| `undeliveredReason` | Why it can't arrive: `its tab closed`, `it would not restart`, … |
| `replies` | The ids of its replies, oldest first |
| `createdAt`, `deliveredAt`, `answeredAt` | ISO 8601 times |

The app reads a tab's messages with
`window.electronAPI.agentMessages.forPanel(panelId)`
(`agent-messages:for-panel`). That returns up to 200 records, newest first,
that the tab sent or received. `onAgentMessagesChanged` fires
(`agent-messages:changed`, with no payload) when any message changes. A chat
or terminal history shows a message's text with its reply line at the end. To
draw a message as a message, match the line `Reply with runpane reply M-n` (or a
`reply: M-n →` line) to its record by `ref`.

Messages live in the `agent_messages` table in `sessions.db`
(`main/src/database/agentMessagesSchema.ts`) and are kept for 30 days. The code
is in `main/src/services/agentMessages/`: the store, the service (outbox,
waiters, delivery), the host that binds it to the running Pane, and the text
of the lines Pane adds. `main/src/ipc/agentMessages.ts` holds the daemon
channels (`runpane:reply`, `runpane:messages:list|show|wait`).
