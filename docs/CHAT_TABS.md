# Chat tabs

A chat tab runs Claude or Codex as a conversation, with no terminal. Pane is an
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) client; the agent
runs through its ACP adapter, `@agentclientprotocol/claude-agent-acp` or
`@agentclientprotocol/codex-acp`. A chat tab stays a chat: there is no
Chat/Terminal switch and no move into a terminal. "Claude in Terminal" and
"Codex in Terminal" in the + menu open terminal agent tabs, as before.

Chat tabs are experimental. Turn them on in **Settings → Advanced → Chat tabs**.
While they are off, the + menu has no chat entries and new Sessions open their
orchestrator in a terminal. Open chat tabs keep working.

## Opening one

- **Desktop**: the + menu lists **Claude**, **Codex** and **Agent Farm
  profile…** under *New tab*, then *In a terminal*: the terminal agents and a
  plain Terminal. The empty Pane screen offers the same.
- **Remote PWA** and **phone**: *Add Tool* lists the same three chats first
  when the host has chat tabs on.
- **Agent Farm profile…** asks for a profile name and optional arguments, one
  `key=value` per line, and opens the chat tab on the Pane's machine exactly as
  `--agent-farm <profile> --arg key=value` does. The name is typed, not picked:
  `agent-farm profiles list` prints no machine-readable list. An unknown profile
  shows Agent Farm's error in the dialog and opens nothing.
- **runpane**: `runpane panels create --pane <id> --chat --agent claude|codex`,
  or `--agent-farm <profile> [--arg key=value …]` for an Agent Farm profile.
  `--initial-input` is the first prompt, sent once.
- **Sessions**: with chat tabs on, a new Claude or Codex Session runs its
  orchestrator in a chat tab (see [SESSIONS.md](SESSIONS.md)).

## Where the agent runs, and sign-in

The agent runs on the tab's host: this computer for a local Pane, the other
machine for a Pane on a connected machine. Clients (desktop, PWA, phone) only
show the conversation and send messages.

A Claude chat tab always runs the person's installed, unmodified `claude`
(the adapter gets `CLAUDE_CODE_EXECUTABLE`); a Codex chat tab runs the installed
`codex` (`CODEX_PATH`). Pane never uses a bundled copy, never reads, stores or
relays a Claude or ChatGPT login, and never copies one between machines.

- **Not signed in**: the tab stops and says so, with **Sign in in Terminal**,
  which opens a terminal tab running `claude auth login` or `codex login` on
  that machine. Press **Retry** after signing in. The tab never retries alone.
- **Not installed**: the tab says so and links the install page.
- **API key (optional)**: Settings → AI & Agents → *Chat tab sign-in* keeps an
  Anthropic or OpenAI key in the OS secure store on that machine (Electron
  `safeStorage`) and passes it only as env (`ANTHROPIC_API_KEY`;
  `OPENAI_API_KEY` and `CODEX_API_KEY`). It is never synced or sent to clients.

Chat tabs don't run in WSL projects or on SSH hosts.

## Adapters

Pane installs the pinned adapters on first use, under `agent-adapters/` in its
data folder: `claude-agent-acp` 0.100.0 and `codex-acp` 2.5.0
(`main/src/services/agentChat/adapterSetup.ts`). Change a pin only after running
the chat tab suites against the new version.

## What the chat shows

- Replies stream as markdown; thinking is collapsed.
- The agent's steps are grouped by kind: *Explored 2 files, 1 search*,
  *Edit file +18 −4* with **View diff** (which opens Pane's diff view; a diff
  never renders in the thread by itself; the PWA and the phone bring the Pane's
  Diff tab forward, which shows the branch's changes read-only), *Run* with the command's output
  streaming in its own row, *Ran 9 commands*.
- To-do lists from the agent's plan updates.
- **Approvals** dock above the composer with exactly the choices the adapter
  sent; keys 1 to 9 answer while the composer is empty. Typing a message
  instead declines the request and sends the message. ExitPlanMode shows the
  plan itself.
- **Questions** (ACP form elicitation, such as Claude's AskUserQuestion) dock
  as a form. Pane declares `elicitation.form`; without it Claude turns
  AskUserQuestion off.
- The `/` menu lists the agent's own commands and skills; the chips change
  model, mode and effort; **Stop** cancels the turn. A message sent while the
  agent works is queued and sent next; **Remove** takes it out of the queue.
- The composer shows the machine the agent runs on.

The Session orchestrator's chat is *quiet* (D-18): a finished turn folds to one
line, "Worked 2 m 40 s · 14 steps · edited 2 files · ran 9 commands", that opens
to its steps; while a turn runs only its current step shows. Each worker Pane is
one line with its state, PR and **Open**, drawn from Pane's own Session state
(its Panes, their agent states and `runpane report`s), never from what the agent
wrote.

Approvals and questions are also asked in Notify and on the phone (see
[PANE_NOTIFY.md](PANE_NOTIFY.md)), a question form one field at a time. The
first answer wins everywhere.

## Restart and resume

A chat tab saves its agent, its launch (plain agent with an optional session
mode, or an Agent Farm profile and its args), its working folder and the ACP
session ID. It saves no env and no secret: env is rebuilt at every start, and an
Agent Farm profile is printed again.

After Pane restarts, a chat tab starts again when you open it (or on
`runpane panels resume` / `resume-many`), loads its conversation (the adapter
replays the history) and shows it. A turn that was running when Pane closed is
marked *Stopped when Pane closed*; a message sent then continues the same
conversation. If the agent exits, the tab shows why with **Restart**, which
loads the same conversation.

## Cost

- No process polling: Pane learns about the adapter's exit from its own events,
  and stops the adapter's whole process group when the tab closes.
- No cap stops a conversation: the newest messages stay in memory (up to 1,000
  or 24 MiB per tab) and older ones go to a per-tab file under `chat-tabs/` in
  Pane's data folder, rebuilt at every start. Viewers keep a window of at most
  about 700 messages: **Earlier messages** pages older ones in
  (`chat-tab:history`) and drops the newest, **Newer messages** pages back
  down, and the jump-to-latest arrow returns to the live end.
- A queued message keeps only a preview in the tab's saved state; its full text
  and images wait in a file beside it until they are sent.
- A tool step's update sends only the fields that changed; command output is sent
  as appends.

## runpane on chat tabs

`panels submit` sends an ACP prompt and returns an `acp-receipt` (queued while
the agent works). `panels wait` is ready when a turn ended and nothing is queued,
and returns at once as blocked while an approval or question waits. `screen`
and `output` read the transcript (`source: acpTranscript`), `last-message` the
newest reply, `report` is kept in the tab's state, and `resume` restarts the
agent and loads the conversation. `panels input` and `submit-composer` fail with
`CHAT_TAB_NO_TERMINAL`: a chat tab has no terminal. The agent gets the same
`PANE_*` env as a terminal agent tab, so `runpane report` and `notify` work from
inside it.

## Agent Farm profiles

For `--agent-farm`, Pane runs `agent-farm run <profile> --print-acp --acp-adapter
<pinned adapter> [--arg key=value …]` at every start, spawns the printed `argv`
with the printed `env` added, sends the printed `session` on `session/new` and
`session/load`, and selects the printed `mode` with `session/set_mode` after each.
The profile's model, effort, instructions with LAUNCH CONTEXT, skills,
subagents, MCP servers and telemetry come with it. The contract is Agent Farm's
CONFIGURATION.md, *ACP sessions*.

## Older clients

Phone apps released before chat tabs would crash on a tab kind they don't know,
and send no version. `panels:list` lists chat tabs only to clients that pass
`{ chatTabs: true }` (this desktop, the PWA and the current phone app), so older
apps don't show chat tabs at all; to use them, update Pane on the phone (D-100).
Released apps have no channel that could say so: their "Update Pane" notices
are about an older computer, and Notify `info` items are not pushed.

## Code

| Part | Where |
| --- | --- |
| Host runtime, transcript, launcher, Agent Farm profiles, Notify bridge | `main/src/services/chatTabs/` |
| Commands (`chat-tab:*`) | `main/src/ipc/chatTabs.ts` |
| runpane | `main/src/ipc/runpaneChatTabs.ts`, `main/src/ipc/runpane.ts` |
| Shared types, presentation, decoders | `shared/types/chatTab.ts`, `shared/chatTabPresentation.ts`, `shared/chatTabPermissions.ts`, `shared/chatTabQuestions.ts`, `shared/types/chatTabDecoders.ts` |
| Viewer (window, paging, catch-up), shared by every client | `shared/chatTabViewer.ts` |
| Desktop and PWA UI | `frontend/src/components/chatTab/`, `frontend/src/remote/components/RemoteChatTab.tsx` |
| Phone UI | `native/src/features/chatTab/` |

## Testing

Tests never touch a real Claude or Codex account. `main/src/services/chatTabs/testing/scriptedAgent.mjs`
is a scripted ACP agent (each prompt's first word picks a behaviour: `permission`,
`question`, `slow`, `crash`, `steps 6`, `edit`, `plan`, …), and `fakeAgentFarm.mjs`
prints a `--print-acp` launch for it. An unpackaged Pane started with
`PANE_CHAT_TEST_AGENT=<path to scriptedAgent.mjs>` runs it in every chat tab;
`tests/chat-tabs.spec.ts` uses that for journeys J1 and J5: run it with
`pnpm build:main && pnpm test:chat-tabs` (CI runs it in Functional Smoke).
