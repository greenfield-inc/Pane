# Severity examples

Worked gradings for the rubric in [CRITERIA.md](CRITERIA.md#severity-how-bad-a-finding-is). Match a new finding to the closest example before choosing its level. The first seven come from one review of a terminal-workspace app (Pane) where two reviewers graded the same bugs differently.

| Finding | Harm | Reach | Recovery | Level |
|---|---|---|---|---|
| A wait-for-idle command (`panels wait --for idle`) succeeds after the agent process has exited | High: an orchestrator treats a dead worker as alive and waits on it | High: any agent that exits | Silent | Must-Fix |
| Two concurrent resumes of the same session both type the launch command | High: stray input lands in a fresh agent | Low: needs two resumes at the same moment | Visible | Should-Fix |
| An HTML preview doesn't reload when Preview is pressed a second time | Medium: shows stale content | High: every edit-then-preview | Visible; reopening works | Should-Fix |
| `resume` reports a generic failure and hides why the relaunch failed | Medium: misleading message | Medium | Visible; `--json` carries the reason | Should-Fix |
| A secondary client (the Python CLI) returns a generic error code (`ERR_RUNPANE_FAILED` instead of `ERR_SESSION_PAYLOAD_INVALID`) and lists only the first payload problem | Medium: an agent that branches on the code takes the wrong path | Low: that client only | Visible | Must-Fix (public contract: error codes) |
| A "View source" action is hidden for worktrees on WSL paths | Low | Low: WSL worktrees only | Visible | Suggestion |
| A move-to-host picker greys out machines whose owner allows everyone on the tailnet, though the CLI allows the move | Medium: blocks an action that should work | Medium | Visible; no workaround in the UI | Should-Fix |
| A query on a send-message path reads every row the sender's team owns; the PR shows it fast on test fixtures but never states the cost for the largest team in production | High: one slow query on the normal path degrades the database for everyone | High: every send, worst for the biggest accounts | Silent until users notice | Must-Fix |

Whenever a person overrules a reviewer's severity, add the finding here with the grading they gave and why. Keep the list to about 8 to 12 entries, with at least one example of each level; replace the least instructive entry rather than growing past that.
