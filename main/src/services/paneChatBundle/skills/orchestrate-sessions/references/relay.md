# Relay

How a worker's `needs_you` (standing rules, Questions for the person) reaches the person, and how the answer goes back. One round at a time, newest blocking question first; batch `fyi` blocks into the map instead.

## A check, not a pipe

Before a worker's question goes to the person, check it:

- Answer it yourself when an approved source settles it (the person's request, the plan, an earlier D-n), and say which. Only the rest goes to the person.
- Check its premises: is the assumed constraint real, is a simpler option missing, is each comparison true? When its options fall short of [Presenting decisions](../SKILL.md#presenting-decisions), send it back to the worker instead of filling the gaps with guesses.
- Every option has a consequence, one is recommended, and its files are listed. Keep the worker's options and wording otherwise.
- A product decision goes on its own, never inside a batch of technical items.

## To the person

In Pane, relay it into the worker's card the way the `pane` skill's "Asking the person in Pane" section and `pane-orchestration`'s "What waits on the person" say (`runpane notify --relays <item>`, its files as links). Never put a worker's question through Claude's own card (AskUserQuestion): a worker's question is always an approval card.

On a host without Pane's approvals, put the round in the conversation, its files opened beside the person, or a `Context: <where the context lives>` line when it has none:

```text
[Needs you · <role> · <feature>] Q-n <title>
1. <question>?                                        (<header>)
   a. <option> (recommended): <consequence>
   b. <option>: <consequence>
   Why: <why>
Files   <each file, opened beside you>
Context: <where the context lives>                    (only when there are no files)
```

## Back to the worker

- **An answer.** Record it as the next D-n in that work's decision log, or in the map's Decisions log when the work has no bundle. In Pane, a relayed answer already reached the asking tab: record it with `runpane inbox ack <item> --decision <D-n>`. Elsewhere, send one line to the asking tab only: `answer: Q-n → <the answer, quoted exactly when it is free text>. Recorded as D-n.` Nobody else gets it; a decision that changes other running work goes out as an addendum.
- **A question back.** When the person asks about the question instead of answering it, send `clarify: Q-n → <the person's question>` to the asking tab, even when you can answer it yourself from an approved source (then add your answer and its source after it, and show the person the same), so the worker adds it to `why`. Q-n stays open and nothing is recorded. In Pane, a typed reply to a relayed question goes to the worker's tab, and the worker reads it as the Replies rules say; when it comes to you instead, you are its reader: run `runpane notify --took <id|Q-n> question`, send the `clarify:` line, and update the same card with `runpane notify --update`, never a second card.
- **A clash.** Q-n are unique per Session. When a worker's id is already used in the map, relay it under the next free Q-n and answer `answer: Q-9 (raised as Q-3) → …`.

Never answer a product question for the person, and never treat their silence as an answer.
