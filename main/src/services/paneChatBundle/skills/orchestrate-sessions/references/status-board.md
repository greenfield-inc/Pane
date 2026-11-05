# Status board

One HTML page for the person, updated in place. Write it to `session/index.html`
in the Session folder: Pane shows that file in the Session's Overview tab, so it
needs no `panels open`. Link each question that waits in a tab to
`pane://open?pane=<pane-id>&panel=<panel-id>`; the link opens that tab with its
waiting Notify card docked. The links work only while the page loads as a local
file.

```
Header            run name, started, last updated, sessions running / queued / done,
                  total cost and elapsed time

Needs you         first and impossible to miss: failed sessions with their failure
                  summary, blocked sessions with what is missing,
                  and open questions with what is waiting on them

Lanes             one row per work item:
                  item | worktree | role and agent | stage | current step | elapsed |
                  cost | blocker | PR link

Decisions log     time | item | question | answered by (brief, plan, person) | answer

End of run        what was done and why
                  what needs your review
                  worktrees still open, and the reason for each
```
