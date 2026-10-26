# Loops

A loop runs an agent or command on a schedule. It runs in one of two places:

- **A project.** Each run gets its own Pane (workspace) in a fresh worktree and
  branch, so the result of a nightly bug sweep or a weekly dependency check is
  ready to review like any other Pane.
- **A Session.** Each run sends the loop's prompt to that Session's agent, with
  no new Pane, worktree or branch. Use it for a job that spans all your
  projects, such as a morning standup summary. See [Session loops](#session-loops).

A project loop is a cron schedule plus the same request `runpane panes create`
takes:

- the repository (`--repo`)
- the agent (`--agent claude`, `codex` or `cursor`) or a custom command
  (`--tool-command`, such as `./scripts/nightly-report.sh` or `pnpm test`)
- optional text typed into the agent or command after it starts (`--prompt
  <text>`, or `--prompt-file <path>` to read it from a file; `-` reads stdin)
- a worktree and branch name template (`--worktree-name`, CLI and MCP only),
  `loop-<name>` by default. Each run adds its date and time, such as
  `loop-nightly-bug-sweep-20261024-0300`.

## When to use a loop

Use a loop for a large job that should run on a schedule: a nightly bug sweep,
a weekly docs audit, a Monday dependency check. Loops run at most once an hour.

An agent that needs to wait a few minutes, for CI or a review, sleeps and
wakes with its own tools (such as a sleep command or its harness's wake-up
timer).

## In the app

Open **Loops** in the sidebar, under Home and Pane Chat. The Loops page lists
every loop across your projects. Select one to see its schedule, next run, the
strip of its last 10 runs and a table of those runs. **+ New** and **Edit** open
a side drawer where you pick the project, what runs (Claude, Codex, Cursor or a
command), and the schedule. Each run's branch is named after the loop, as
above.

The schedule works like Google Calendar's Repeat field. Pick **Hourly**,
**Daily**, **Every weekday (Monday to Friday)**, **Weekly** (choose the days),
or **Monthly** (choose the day of the month), then the time. The drawer shows
the schedule in words, such as "Weekly on Mon, Wed, Fri at 9:00 AM", the next
three run times and the cron it saves. **Custom cron** takes any five-field
cron. Editing a loop opens its cron in the matching mode, or in Custom cron
when no mode matches.

A run's Pane shows a breadcrumb above its tabs (Loops › loop › run) that leads
back to the loop, and a rail that switches between the loop's runs. Its
Details / Files / Changes sidebar starts closed; open it once and run Panes
keep it open.

## From the CLI

Create a loop that starts Claude every day at 03:00:

```bash
runpane loops create --repo active --name nightly-bug-sweep \
  --cron "0 3 * * *" --agent claude \
  --prompt "Pick one bug from yesterday's issues, fix it, and open a PR." --yes
```

Run a custom command every Monday at 09:00:

```bash
runpane loops create --repo my-app --name dependency-check \
  --cron "0 9 * * 1" --tool-command "./scripts/nightly-report.sh" --yes
```

Check a schedule before saving it. `--dry-run` prints the schedule in words and
the next run time, and saves nothing:

```bash
runpane loops create --repo active --name docs-audit --cron "0 16 * * 5" \
  --agent codex --prompt-file audit.md --dry-run
```

Manage loops by id (`runpane loops list` shows it):

```bash
runpane loops list
runpane loops update --loop <id> --cron "0 4 * * *" --yes
runpane loops run --loop <id> --yes
runpane loops pause --loop <id> --yes
runpane loops resume --loop <id> --yes
runpane loops delete --loop <id> --yes
```

`--repo` takes the same selectors as `panes create`: `active` (the repo
selected in the app), a repo id, an exact path or a saved name. Commands that
change a loop need `--yes` when run from a script or agent; in a terminal they
ask first. `update` changes only the values you pass; `--agent` and
`--tool-command` replace each other. Add `--json` to any command for
machine-readable output. The same commands are MCP tools: `loops_list`,
`loops_create`, `loops_update`, `loops_run`, `loops_pause`, `loops_resume` and
`loops_delete`, in the `loops` toolset (see
[Pane MCP Server](PANE_MCP.md#toolsets)).

## Session loops

A Session loop targets a Session instead of a project. In the app, choose
**Runs in: Session**, then pick **New Session for this loop** (named after the
loop) or an existing Session. From the CLI, pass `--session` instead of `--repo`,
with a Session id, its name, or `new`:

```bash
runpane loops create --session new --name morning-standup --cron "0 9 * * 1-5" \
  --agent claude --prompt "Summarize what changed across my projects since yesterday." --yes
```

- **Agent only.** A Session loop runs Claude, Codex or Cursor; it has no
  command, and it needs a prompt.
- **Unattended for every message.** Saving the loop makes the Session's agent
  skip permission prompts, with the same launch flags as project runs (`claude
  --dangerously-skip-permissions`, `codex --yolo`, `cursor-agent --force
  --trust`). That holds for every message the Session gets, not only loop
  runs. A custom launch command gets the flags added after the agent's
  program; one Pane cannot change safely (a wrapper such as `sh -c`, an
  `env` or variable prefix, or `&&`, `;`, a pipe or a redirect) is refused
  when you save. Picking an agent other than the Session's switches the
  Session to it.
- **The Session's folder is trusted.** For a Claude loop, saving marks the
  Session's own folder (Pane's Session directory, never a project) as trusted
  in Claude's project trust setting, the record its "trust this folder" prompt
  writes, so the first run is not stopped there. Codex can still stop at its
  update menu when a new version is out; answer it once in the Session.
- **Restart a running agent once.** An agent that is already running keeps
  the flags it started with. Until you exit it and start it again (it resumes
  the same conversation), runs are held and show as **needs attention**. Pane
  never restarts it for you.
- **A run.** Pane starts the Session's agent if it is stopped, then sends the
  prompt to it. An agent busy with a turn gets the prompt queued after it. If
  the agent is stopped at a prompt of its own, or its launch exited back to
  the shell, the loop's prompt is not sent (Pane never types it into a shell)
  and the run shows as **needs attention**; open the Session and fix it.
- **Kept runs.** The last 10 runs are listed. There is no run Pane to archive.

## Rules

- **Schedule.** One five-field cron expression, in the local time zone of the
  machine running Pane. `0 3 * * *` is "Daily at 3:00 AM"; `0 9 * * 1` is
  "Weekly on Monday at 9:00 AM". The app and `runpane loops` describe a
  schedule in these same words.
- **At most once an hour.** Saving rejects a cron whose runs fall less than 60
  minutes apart.
- **Pane must be running.** Runs start only while Pane is running on that
  machine.
- **Missed runs.** A run up to 15 minutes late still starts, for example after
  the computer wakes from sleep. A later one is recorded as skipped. Missed runs
  are never caught up.
- **Overlap.** A run starts even if the previous one is still going.
- **Kept runs.** Pane keeps each loop's last 10 runs and archives older run
  Panes. A run Pane with uncommitted or unpushed work is not archived: its run
  stays in the loop's list with the note "Kept because the run Pane has
  uncommitted or unpushed work", so a loop can show more than 10 runs. Archive the Pane yourself
  when you're done; Pane tries again after each new run.
- **Delete.** Deleting a loop stops its schedule. Its run Panes stay, as
  normal Panes.
- **Pause.** A paused loop starts no scheduled runs. Resuming picks up at the
  next scheduled time.
- **Permissions.** Runs are unattended, so Claude, Codex and Cursor runs skip
  their permission prompts. A `--tool-command` runs as written.
- **Commands on Windows.** A `--tool-command` runs in Pane's terminal shell,
  which is Git Bash by default. Write it in bash, or call cmd with `//c`:
  `cmd //c echo hi > loop.txt` works. With `cmd /c`, Git Bash turns `/c` into a
  path, so cmd starts interactively and the run hangs.
- **Folder trust.** Claude and Codex ask whether to trust a folder they have
  not seen, and each project run is a new worktree. A run stopped at that prompt shows
  as **needs attention**. Open the run and answer it, or open the project
  folder in the agent once and trust it so later runs start on their own. Pane
  never answers a trust prompt for you, and only pre-trusts a Session loop's own
  folder (see [Session loops](#session-loops)).
- **Run now.** `runpane loops run` starts a run immediately, even while the
  loop is paused. The schedule stays the same, and the run counts toward the 10
  kept runs.

## Runs

Each project loop run is a new Pane in a fresh worktree branched from the
repository's default base branch. It appears as a normal Pane under its
project, and you review its work the way you review any Pane. A Session loop's
runs happen in its Session; their `sessionId` is null.

`runpane loops list --json` lists each loop's runs, newest first. A run's
`status` is:

- `started`: its Pane was created, or a Session loop's prompt was sent. For a
  project loop, `sessionId` is that Pane's id, so read its
  progress with `runpane agents status --pane <sessionId>`. When `error` is set
  too, something needed attention when the run started: the agent was stopped
  at a prompt such as folder trust, never became ready, or Pane could not
  confirm the prompt arrived. The app and plain `runpane loops list` show such
  a run as **needs attention**. On an older run, `error` can instead be the
  note that its Pane was kept for its uncommitted or unpushed work.
- `failed`: the Pane could not be created, or the Session could not be
  reached; `error` says why.
- `skipped`: the run came and went while Pane was not running or the computer
  was asleep.
