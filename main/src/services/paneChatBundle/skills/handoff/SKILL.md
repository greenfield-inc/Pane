---
name: handoff
description: Prepare a verified resumption brief when moving work to another agent, device, or session, including local-to-cloud coding handoffs, and start the receiving agent with `runpane handoff`. Use for "hand this off," "continue on my Mac," "give this to Codex," or "save where we are."
---

# Handoff

You are the outgoing collaborator. Give the next person or agent the verified context, decisions, and lessons needed to pick up where you left off.

## Capture what matters

- Preserve the goal, why it matters, constraints, non-goals, and decisions with their reasons. Distinguish approved work from suggestions.
- Verify the current state. Record completed work, remaining work, meaningful failed attempts, blockers, and the next concrete action.
- Link authoritative instructions, plans, evidence, and artifacts. Make the brief self-contained and focused on what the next worker needs.
- Include pending approvals and the scope of authorized work. Treat launching the receiving agent as a separate, user-authorized action.

## Make coding work portable

- Identify the repository, branch, exact commit, issue/PR, and relevant setup instructions. Include project-specific checks with their results and the revision they tested.
- Inspect staged, unstaged, untracked, and unpushed work. Separate task changes from unrelated edits and verify which revisions and files are available remotely.
- Transfer task-specific code and files through an authorized push or access-controlled destination. Preserve unrelated work and identify any files still awaiting transfer.
- Record required tools, services, and credential setup references. Keep secret values in their approved secret store and check the receiving agent’s plugin, skill, and network prerequisites.
- Keep private code and patches in access-controlled locations. Identify the next step needed to resolve any transfer or permission blocker.

## Write the note

Write the brief as the handoff note in [references/note-template.md](references/note-template.md): a compaction of your session, in nine required `##` sections, for a reader with none of your context.

## Start the receiving agent

When the person asks for another agent to continue, on this machine or another of theirs, use `runpane handoff`. It works the same from any harness. "Hand this to Claude on my Mac" authorizes starting that agent; it does not authorize pushing.

When you run in a Pane tab and the receiver is the same agent as you (Claude, Codex, Cursor or OpenCode), the handoff carries your own session: the receiver continues your conversation, not a fresh agent. On another machine, your session's files are copied into that machine's agent store and the receiver resumes the same session. On this machine, the receiver resumes a fork of it, because two agents never resume one session on one machine. You still write the note: the receiver gets it as context, and it is all a fresh agent gets when the session can't be carried.

1. Find the machine's name: `runpane workspace list` lists the person's machines (a unique prefix such as `macbook-pro` works). Ask when more than one fits.
2. Get the template outside the checkout, so it is never committed: `runpane handoff --template > ~/handoff.md`. Fill in every section; write "None" where one does not apply. Leave the front matter alone, and don't add instructions for the receiver: the CLI rewrites the front matter and appends them when it sends.
3. Make the work reachable. Commit the task's files yourself; leave unrelated edits uncommitted. If the branch is not pushed, ask before pushing, then push it or pass `--push` (it commits every remaining change except the note as WIP and pushes; it never forces).
4. Check the destination: `runpane handoff "claude opus on <machine>" --note-file ~/handoff.md --dry-run`. The destination is freeform: the agent (claude, codex, cursor, or opencode to continue an OpenCode session), and optionally the model, the effort and the machine, such as `"codex gpt-5 high on parsa-devbox"` or `"cursor on this machine"`. `--machine`, `--agent`, `--model` and `--effort` override the text. Effort is supported for Claude and Codex; Cursor effort is rejected before committing or sending. The dry run's `continuity` says whether your session will be carried (`carried`, `sessionId`, `fork`, `files`, `bytes`) and, if not, why (`reason`).
5. Send it: the same command without `--dry-run`. It finds the destination's saved repository with the same remote, writes the note to that machine's `~/.pane/handoffs/`, and starts the agent. On another machine it gets a new Pane branched from yours; on this machine, run from the Pane that owns this checkout, it opens as a new tab in your Pane (1 feature = 1 worktree = 1 branch = 1 Pane), and the JSON's `receiver.route` and `receiver.reason` say which happened. If it fails, relay its message; it names the fix (Pane not running there, repository not saved there, branch not pushed).
6. Read the result. When your session is carried, the CLI checks that the receiver resumed it and shows its last message (see [continuity](../migrate-to-pane/references/continuity.md)), and when the folder or machine changed it tells the receiver where the session moved. JSON `continuity.result` is one of:
   - `continued`: the receiver continues your session.
   - `inconclusive`: the check could not tell. Follow `continuity.next`: ask the receiver "What were you last working on? Answer in one or two sentences." and compare its answer with your own last work. If it matches, send it the moved message `next` gives; if not, treat it as not continued.
   - `not-continued`: the command exits 1. The receiver is kept, never replaced. Tell the person what failed and offer the fresh-agent route that `next` gives (`--note-only`); start it only if they choose it.
   - `fresh-agent`: the note route, used with `--note-only`, a different receiving agent, a tab with no agent session, or a session whose files aren't on this machine. The output says "A fresh <agent> with your note, not the same session"; tell the person that.

   The handoff isn't done until the result is `continued`, `inconclusive` resolved by the probe, or a labelled fresh-agent fallback the person accepted.
7. Tell the person where the receiver started (a new tab in your Pane, or a new Pane on which machine), whether it continues your session or is a fresh agent, and give them the `agents status` command it printed. The receiver pushes to your branch and reports back to your panel, so stop changing that branch. When your session continues there (`continued`, or `inconclusive` resolved by the probe), end your turn and make no more changes on the branch; the person closes your tab.

## Hand off a Session

When you are a Session's agent (your terminal sets `PANE_ORCHESTRATION_SESSION_ID`) and the person asks to move the Session to another machine, for example through **Move to host…** in the Session's right-click menu, run the same steps from the Session's folder. There is no git to move, so skip step 3 and don't push anything.

- Write the note from `runpane handoff --template` as above. Under "Git state", list each Pane this Session coordinates with its machine, branch and PR, or write "None". Name the files in the Session folder worth reading, with their full paths: the receiver can read them with `runpane workspace <this machine> read <path>`, but the Session folder is not copied.
- Check it with `--dry-run`, then send it: `runpane handoff "<agent> on <machine>" --note-file <note>`. It writes the note to that machine's `~/.pane/handoffs/` and creates a Session there with this Session's name (numbered "<name> 2" if taken), goal and the agent you named. The JSON reports `receiver.route` `session` and the new `session`.
- When the receiver is the same agent as you, your agent session's files are copied to that machine and the new Session resumes your conversation when it is first opened. The CLI can't check its history until then, so `continuity.result` is `inconclusive`: tell the person to open the Session and check it shows your last message; if that is unclear, ask it the probe from [continuity](../migrate-to-pane/references/continuity.md); then send it the moved message `continuity.next` gives. Then end your turn.
- Otherwise (`--note-only`, or a different agent) the new Session is a fresh agent whose next action is to read the note, and `continuity.result` is `fresh-agent`. It waits for the person's first message, like every Session: they switch Pane to that machine, open it, and send "continue".
- A Session can't be handed off to the machine it is on; handoff refuses before sending anything.
- Tell the person the new Session's name and machine. This Session stays as it is; they can archive it when they're done with it.

The note goes with every handoff: context for a carried session, and everything a fresh agent gets. Skip the two sections below unless the person also wants a saved page, a Grain workspace or a PR comment, or there is no receiving agent to start.

## Save one authoritative brief

- Honor an explicit destination. Otherwise, when Grain is connected, read its installed skill and update the existing task workspace; if none exists, create a clearly named one in `Development Artifacts`. Retain its ID for subsequent updates.
- When the handoff lands in a Grain workspace and the `session-trace` skill is installed, attach this session's trace to it.
- Make essential text directly readable to both humans and agents. Link existing artifacts and retain one authoritative brief.
- For cross-device delivery, prefer a public-safe Grain share when public sharing is authorized by the request or an established user preference. Otherwise use an appropriately restricted destination or ask before publishing.
- Inspect the full shared content for its intended audience. Use access-controlled GitHub when the brief requires private source or sensitive context. Return the verified share URL supplied by the service.
- If Grain is unavailable or unsuitable, save the handoff as a page in the work's page bundle (see [page](../page/SKILL.md)) and open it for the person. With a posting grant, also update a clearly labeled handoff/status section on the existing PR, or the issue if there is no PR. Preserve the original intent, acceptance criteria, and other contributors' content; use a timestamped comment when editing the body would be disruptive.
- If both destinations are unavailable, return a self-contained, copyable brief in chat with its save status. Create a new issue or PR when the user requests one.
- Keep necessary local working files and verify that required material also has a remotely accessible copy. Report connected save failures and the outcome of any fallback.

## Verify and deliver

- Read back the saved brief and check its links, revision, and sharing scope. Verify public links in a signed-out context when possible, and state the verification status of recipient access to private resources.
- Return the brief's link and a paste-ready instruction to resume, naming the first action and any transfer/access blockers.
- Tell the receiving agent to read repository instructions and reconcile this checkpoint with the current branch, issue/PR, and artifact state before acting.

WSL receivers are currently unsupported and are rejected before committing or sending anything. An OpenCode session travels as its export: `opencode export` on this machine, then `opencode import` inside the receiving repository there, and an OpenCode receiver is accepted only to continue an OpenCode session. Use a native repository. Remote shells must be Bash, Zsh, Sh, Fish, or PowerShell; cmd is unsupported. A staged note must be unstaged before using `--push`. Cursor's session store is undocumented, so carrying a Cursor chat is best effort and the check reports what it found. A destination's agent store is assumed at its default location (`~/.claude`, `~/.codex`, `~/.cursor`).
