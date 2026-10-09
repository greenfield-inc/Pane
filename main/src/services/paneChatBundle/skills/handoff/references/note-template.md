# The handoff note

The note is a compaction of your session for a reader with none of it: a fresh agent, often on
another machine, with no chat history and no memory. It extends Codex's compaction prompt
([openai/codex `codex-rs/prompts/templates/compact/prompt.md`](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/compact/prompt.md)),
which asks for progress and key decisions; context, constraints and user preferences; clear next
steps; and the critical data, examples and references needed to continue. Codex then hands the
summary to the fresh model as work "another language model started", to build on rather than
redo. This note keeps those four and adds what a receiver on another machine needs: what was
verified, how to check it, and where the code is.

Get the exact template, with this checkout's origin and git state already in its front matter:

```bash
runpane handoff --template > ~/handoff.md
```

Every section is required. `runpane handoff` rejects a note with a missing or empty section; write
"None" where one does not apply.

| Section | Write |
| --- | --- |
| Goal | What the work is for and what "done" means, in the person's terms. Link the issue or PR. |
| Current state | Where things stand, in two or three sentences. |
| Done and verified | Each finished item with how you verified it: the command and its result. Unverified work goes under In progress. |
| In progress | Half-done work: what is written, what is not, and any failing test or error, quoted exactly. |
| Next steps | Ordered actions. The first must be concrete enough to start without asking. |
| Decisions and constraints | Decisions with their reasons, the person's preferences, non-goals, and approaches that failed, so they are not retried. |
| Open questions | What only the person can answer, and what you were unsure of. |
| How to verify | Exact commands to build, test and see the change working, with the expected result. |
| Git state | Repository, branch, head commit, whether it is pushed, and uncommitted files that matter. |

## Write it well

- Write facts you checked, not impressions. "Tests pass" needs the command and the commit it ran on.
- Quote errors, commands, paths and ids exactly. Paraphrase loses what the receiver needs to search for.
- Keep it short: a page, not a transcript. Link plans, PRs and evidence instead of pasting them.
- Record what failed and why. It is the part a fresh agent cannot rediscover cheaply.
- Never paste secrets. Name where the receiver gets a credential instead.

## Front matter

`runpane handoff` rewrites the front matter when it sends the note, so the origin and git state are
never stale:

```yaml
---
origin_machine: parsa-devbox        # Tailscale name of the sender's machine
origin_pane: 2a0ccff8-...           # the sender's Pane (PANE_SESSION_ID)
origin_panel: 2535ac9a-...          # the sender's panel; the receiver reports here
origin_session: 6475e054-...        # the sender's Session, when there is one
repository: greenfield-inc/Pane
branch: fix-login
head: 940acc5652a4844f07859def1d89f5d1642aa8ff
remote: origin
pushed: true
---
```

It also appends **Receiver instructions**: read the repository's AGENTS.md, check that the head
commit matches, run "How to verify", continue from "Next steps", push to the sender's branch
without forcing, and report back with
`runpane workspace <origin_machine> panels submit --panel <origin_panel> --text "..." --yes`.
