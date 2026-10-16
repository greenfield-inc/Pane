# The continuity check

One bar for every session that moves into a Pane tab, whether the
[Migrate to Pane](../SKILL.md) skill moved it or `runpane handoff` carried it
from another tab or machine. The person should be able to keep talking to the
same conversation, with everything it knew, as if nothing happened.

## What counts as continued

Mark a session **continued** only when you have observed each of these, not
assumed it:

1. **Same native session, by the agent's own resume.** The tab was started by
   the agent's resume-by-id for the source session's id, or for its fork's id.
   Never by the agent's picker, "latest" or "continue last", or by a fresh
   start fed a summary. Observe it in the tab's launch command, or in the
   agent's own live record of which session it is running (for example the
   per-process session file Claude Code writes, or the session id its `/status`
   shows). Pane's stored id alone is not proof.
2. **A restart comes back to it.** Pane's recorded resume id for the tab
   (`resumeId` in `runpane panels list --pane <id> --json`), or the saved
   launch command for the tab, names that same id, so a Pane restart resumes
   this conversation and not a new one.
3. **History is loaded.** `runpane panels wait --panel <id> --for ready`
   returns ready, and `runpane panels screen --panel <id>` shows the session's
   prior conversation, including the last turn recorded in the copy that was
   opened.
4. **Original untouched** (forks only). When you forked, the original
   session's file and process were not changed: the file has the same size
   and modification time as before you started, and its process is still
   running if it was.

"The last turn recorded" is the last complete user or assistant message in the
copy that was opened. A copy taken mid-turn, as a handoff takes it, ends with
an unfinished tool call, which the agent shows as interrupted; that is
expected.

**Continued as a fork** is the same result for a fork: checks 1 to 4 hold for
the fork's id, and the tab is a new conversation that starts with the
original's history. If the original's file changed at any point, even when a
later fork worked, check 4 failed: report that session as **not continued**,
say what changed it, and leave the person's original as it now is.

## When a check is inconclusive

If check 3 is unclear, because the screen is scrolled, the agent compacted its
history, or the last turn is ambiguous, send one probe:

> What were you last working on? Answer in one or two sentences.

Compare the answer with the session's own record (its last messages in the
store). An answer that names the same work passes check 3; a paraphrase is
fine, a generic or different answer is not. Send at most one probe per session.
If the answer does not match or never arrives, the session is **not
continued**.

## The "moved" message

After the checks pass, and only when the session's folder or machine changed,
send the tab one message:

> This session moved to `<path>` on `<machine>`. Continue from where you were.

Use `runpane panels submit --panel <id> --text "<message>" --yes`. Adopting a
checkout in place changes neither, so it gets no message.

## Report

Report every session as one of:

- **continued**: checks 1 to 3 passed.
- **continued as a fork**: checks 1 to 4 passed for the fork; name the
  original and its new Pane.
- **not continued**: say what happened, why, and the next step the person can
  take.

Never replace a session that failed with a fresh agent, a summary or a note
unless the person says so. A session reported honestly as not continued is
better than a new conversation that looks like the old one.
