# Transcript usage indexing

UsageManager scans all JSONL files recursively beneath `~/.claude/projects`
and `~/.codex/sessions`. This includes Claude subagent transcripts and Codex
`year/month/day` directories. Roots are rediscovered on every pass, including
when their parent directories did not exist at startup.

Indexing runs at startup, every four hours, and on manual Refresh from the usage dashboard or Settings → Usage. There are
no native usage watchers or per-transcript watch handles. Unchanged files are
checked by metadata and skipped; changed files resume from their stored cursor.
The four-hour interval is a scheduling cadence, not a maximum freshness
bound: large scans can take longer. The usage page shows the last successful
scan and keeps errors visible until a subsequent successful pass.

All indexing uses a single queue. Requests made while a scan is running coalesce
into one follow-up discovery pass. A manual refresh waits for its requested pass,
including when an earlier pass is still running. Stop clears the polling timer
and invalidates queued and in-flight work. A lifecycle generation check after
asynchronous operations prevents stopped work from updating events, cursors,
quota samples or status. Restart queues fresh discovery after old reads drain.

Tests use generated transcripts in temporary directories and in-memory SQLite.
Run them with Node 22:

```sh
pnpm --filter main exec vitest run src/services/usage
```

Do not reproduce descriptor exhaustion against a user's real transcript trees.
For resource measurements, generate a disposable tree, constrain only child
processes, and delete only fixtures created by that run.

## Dashboard ranges and per-pane summaries

Usage & limits supports rolling 24h/7d/30d/90d presets and custom inclusive
calendar dates in the viewer's local time zone. Applying dates uses the existing
report query; it does not rescan transcripts. Historical reports contain only
indexed data, subject to the 180-day event retention window. Provider limits
continue to show current provider readings, regardless of the report range.

Per-pane usage defaults to an ordinary average across panes with recorded
usage in the selected period and provider filter, including archived panes.
Empty panes and unattributed events are excluded. Tokens per pane counts input,
output and cache-creation tokens, excluding cache reads. Cost includes all token
categories at estimated API rates, not subscription charges; any missing price
in the eligible sample makes the cost summary unavailable. Messages counts
recorded usage events, not human prompts.

The optional Trim 10% mode independently sorts each metric and removes
`floor(paneCount * 0.1)` values from each end before averaging. Fewer than ten
panes means no trimming. The UI shows the original and retained sample counts.
These summaries describe consumption during the selected period, not lifetime
task costs or completed work. They are derived from the existing report without
additional database queries. Leaderboard calculations are unchanged.
