# Transcript usage indexing

UsageManager scans all JSONL files recursively beneath `~/.claude/projects`
and `~/.codex/sessions`. This includes Claude subagent transcripts and Codex
`year/month/day` directories. Roots are rediscovered on every pass, including
when their parent directories did not exist at startup.

Cursor usage is not in those transcripts. On the same scan, Pane reads the
access token Cursor already stored and calls Cursor's dashboard for the current
plan meters and filtered usage events. Only events whose conversation id matches a Cursor chat Pane knows about
are indexed. That is a chat id captured at launch, or a Cursor CLI chat
stored for a Pane worktree (`~/.cursor/chats/<md5 of the worktree>`),
including archived Panes. The `agent` command is that CLI. Other account usage is discarded
before insert. The Auto and API limit bars are the account plan, not a per-Pane
quota. The first sync covers the 180-day retention window. A later sync replaces
the trailing 48 hours, because a request's token counts can still grow.
If the watermark exists but no Cursor rows were stored, or a Pane chat id
has no stored rows yet, the next pass uses the full window again.
Dashboard pages are followed until a short page comes back. Rows with no
tokens are skipped, and that skip does not end the scan. A failed
fetch leaves the previous Cursor rows in place. Cost uses the same price table
as Claude and Codex, including Cursor's published Composer and Grok rates.

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

## Report queries

Reports read whole hours from `usage_hourly`, a per hour, provider, model and
cwd rollup of `usage_events` that triggers keep in step with every insert and
delete. Only the partial hours at each end of a range, and hours a custom-date
boundary falls inside, are read from raw events, so results match a scan of
every event. Pane attribution resolves each rollup row once; a row whose
events straddle a pane's creation or archive time rereads those events.
`usageAggregator.rollup.test.ts` holds every report to the per-event queries.

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

Custom-date charts use viewer-local midnight boundaries in a single indexed
range-join query, so day labels and totals remain aligned across daylight-saving
changes and fractional-hour time zones, including remote-daemon use. Calendar
defaults contain exactly the preset's number of inclusive dates.
