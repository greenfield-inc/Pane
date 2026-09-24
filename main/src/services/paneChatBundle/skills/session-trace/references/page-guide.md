# What a session trace page is for, and how to lay it out

The reader wasn't in the session. They want to know how it went, not to replay it. Every section should help them answer, in order:

1. What was the job, and what came out of it (PRs, releases, published pages)?
2. How did it get there: the few moments that decided the outcome?
3. Where did the agent go wrong, get corrected, or recover?
4. How long did it take, and what did it cost if that's known?
5. If they want to check any of it: exactly what was asked and done, step by step.

## Capture more than the trace

A timeline of tool calls answers only question 5. Also capture:

- **Outcomes.** Every PR opened, with its link and, if you know it, whether it merged. Releases, tags, deploys, and pages published.
- **Corrections.** Places where the user redirected the agent ("no, simpler", "that's wrong"). These are the most useful moments for anyone improving the agent or its instructions.
- **Decisions.** Choices that shaped the result, and the reason for each.
- **Failures and recovery.** Failed tool calls, broken CI, reverted work, and what fixed it.
- **Cost and time.** Wall clock always. Tokens or dollars only when the log records them, labelled as estimates.

## Layout, top to bottom

1. **Title and lede.** The task, the harness and model, the date and time window. One sentence on what the page is.
2. **Stats row.** Requests, tool calls, subagents, PRs, wall clock.
3. **What happened.** Three to six plain sentences: the job, how it went, what came out, and the one or two things worth knowing. No jargon a newcomer wouldn't know.
4. **Key moments.** 4–8 cards, in time order. Each card has the time, a short title, and one sentence on why it mattered, and it links to its request. Pick from: the original ask, decisions, user corrections, failures and recoveries, merges and releases, and surprises. Skip routine steps.
5. **Timeline.** One row per request on the session's clock, with its first line beside the bar. Mark PRs as ticks above it and star the key moments. Show subagents as their own rows in a second colour.
6. **Pull requests.** A linked list with times, and status when known.
7. **Every request, step by step.** Collapsed by default. Each shows the full ask (long pastes trimmed with a note), each tool call with a timing bar and its description, earlier progress updates collapsed, and the final reply.
8. **Subagents.** The same step view for each child agent.
9. **Raw trace.** A link to the OpenTelemetry JSON.

## UX principles

Keep these whatever the layout becomes:

- **Summary first, detail on demand.** The page opens as a short read (story, moments, timeline). Every request starts collapsed.
- **Everything links to its evidence.** Timeline rows and key-moment cards jump to their request and open it. A jumped-to item is highlighted, and each opened request has a way back to the timeline.
- **Findable in a long session.** A filter box narrows requests by what was asked or done, and one button expands or collapses them all.
- **Works at any width.** Grids collapse to one column, bars get taller tap targets, and long text wraps instead of overflowing. Check a phone width as well as desktop.
- **Readable for everyone.** Light and dark themes, visible keyboard focus, no motion when the reader prefers reduced motion, and full text available on hover or when opened.
- **Plain words.** Labels say what things are ("requests", "tool calls"), not internal names.

`scripts/build-trace.mjs` implements this layout. Treat its output as the reference design, and keep new pages consistent with it rather than redesigning each time.

## The story file

`--story` takes JSON:

```json
{
  "summary": "Paragraphs separated by a blank line.",
  "moments": [{"turn": 4, "title": "Chose a real feature over a workaround", "detail": "Why it mattered, in one sentence."}]
}
```

`turn` is the request index from `--outline` (`t4` is `4`).

## Privacy

- User messages appear in full. That's the point, and also the risk: pasted meeting notes, logs, or customer data go along with them.
- Automatic redaction covers emails and common token shapes only. Read the requests before publishing.
- Command output isn't included, only each command's description and first line.
- Publish privately. Only the user decides to share.

## Other harnesses

Map any log onto the same model, then render the same page:

| Page element | What to extract |
| --- | --- |
| Request | Each message the human typed (skip injected context, system reminders, and tool results) |
| Step | Each tool call: name, a short description, start time, end time (when its result arrived), and whether it failed |
| Reply | The agent's text messages; the last one in a request is its answer |
| Subagent | Child threads or agents, with their own steps |
| PR | Pull-request URLs from the harness's PR records, or from the output of `gh pr create` |

OpenTelemetry shape: one root span for the session, one `user_request` span per request, `tool.<name>` spans under it, a `subagent` span per child with its tool spans, and a zero-length `pull_request.opened` span per PR.
