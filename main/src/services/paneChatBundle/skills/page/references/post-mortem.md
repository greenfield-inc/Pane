# Post-mortem

A short HTML page for the person about a PR where something went wrong. The orchestrator writes it after the PR's review loop closes, or when the PR merges or closes unreviewed, and only when something went wrong: a worker timed out, a tab died, a permission or tool was missing, a step crashed, or a fix loop thrashed. A PR that went cleanly gets no post-mortem; its card and front page say "no issues hit". Standalone, with no orchestrator, the implementer writes it the same way at the end of its run.

Its home is the PR's own artifact (`prepare-pr`'s companion page, or the local companion folder), linked from the item's front page, and noted on its Done entry on the status page. Gather it from the workers' status files (`failure` and `attempts`), the orchestrator's own events, and the traces. Lead with the outcome and whether the feature actually works, against the approved plan when there is one.

- **Outcome:** merged, closed, blocked or failed; delivered behavior, unfinished requirements, tested revision, and links to the plan, PR, verification evidence, and conversation viewer.
- **Issues hit:** each thing that got in the way, with its evidence (a status-file field, an event, a trace moment, a log line): what happened, what was tried, how it recovered or what remains unresolved, and the root cause when known. Keep observed facts apart from hypotheses.
- **Issues to file:** one row per problem worth a GitHub issue: the repository that owns the failing piece (the tool's own repository, or the project's), a title, and a short body with private paths, customer text and session content removed. The orchestrator puts these to the person as one question listing each with its repository and title, and files nothing without the person's yes.
- **Surprises and deviations:** original approach → actual approach, why it changed, and approval where required. Say explicitly when there were none.
- **Verification and review:** results against "How we will know it works," the review mode, findings and fixes, and remaining gaps. Call behavior complete only when it was tested.
- **Lessons:** a few actionable improvements for future plans or runs, based on this evidence. Include time, token, or cost figures only when measured and scoped; mark estimates and missing telemetry.

Link back to the front page. Keep it factual, concise, and useful to someone who did not watch the run. Summarize tool output instead of pasting raw logs, and give reasons for delays only when the evidence shows them.
