# Coordination token simulation

Run from the repository root:

```sh
node scripts/simulate-agent-communication.mjs
```

This is a reproducible synthetic model, not measured billing or a live agent
benchmark. It imports the shipping `WatchCadence` implementation rather than
guessing its batching. No model API is called.

Assumptions: eight panels over eight hours, four tasks per panel, 12 model/tool
rounds per task, 16,000 tokens of orchestrator or worker context per model wake,
600 screen tokens or 120 event tokens per observation, 100 output tokens per
decision, and 160 receipt/reply tokens per correlated task. Each panel has one
blocker during the run. Synthetic false-ready pauses last four minutes, so some
survive the existing three-minute settle and ten-minute batching. The script also
tests 50% correlated coverage and zero/two/six false stops per task.

For two false stops per task and full correlated coverage:

| Approach | Orchestrator wakes | Coordination tokens |
| --- | ---: | ---: |
| Model polls all eight screens every minute | 480 | 10,032,000 |
| Current cadenced watcher | 104 | 1,736,800 |
| Model wakes on every Pi `turn_end` | 392 | 6,358,240 |
| Correlated waits, receipt/reply batched into existing work | 40 | 653,920 |
| Correlated waits, one extra worker model round per task | 40 | 1,169,120 |
| Correlated waits, two extra worker model rounds per task | 40 | 1,684,320 |

The 62.3% reduction is an optimistic case with **no extra worker model rounds**.
One extra round reduces the saving to 32.7%; two reduce it to 3.0%. A native inbox
avoids a model-driven inbox read, but explicit replies may still add a round.
Batching them into an existing test/result tool call avoids that extra cost.

| False stops per task | Batched receipts | One extra worker round | Two extra worker rounds |
| --- | ---: | ---: | ---: |
| 0 | 2.1% fewer tokens | 75.0% more | 152.1% more |
| 2 | 62.3% fewer | 32.7% fewer | 3.0% fewer |
| 6 | 83.1% fewer | 69.8% fewer | 56.5% fewer |

The best combination is selective: keep deterministic observation and existing
liveness checks; use compact task-correlated communication for cooperating
agents; prefer native delivery and batch explicit acknowledgements; retain
terminal fallbacks for other agents. Switching from one deterministic socket
transport to another does not itself save tokens.

The model includes extra receiver coordination context but excludes the underlying
implementation/review work, initial setup instructions, summarizer calls, retries
and error recovery. Blockers are counted once. If all eight blockers produce both
an explicit reply and a watcher notification, add roughly 129,760 tokens to the
hybrid totals (eight extra 16,000 + 120 + 100 token wakes). Payload lengths, context
sizes and prompt caching vary in real runs. The JSON also reports an illustrative
90% cached-context scenario with a 0.1 cache-read weight; these are weighted tokens,
not dollar prices or a claim about any provider's billing.

Before changing defaults broadly, collect real task ids, false-ready counts,
orchestrator wakes, extra worker turns, token usage and completion latency from a
representative workstream. The simulation supports an interface improvement and
a configurable hybrid, not a guaranteed universal token saving.
