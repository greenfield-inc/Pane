# Machine health

Pane keeps the disk and memory of every machine it runs on healthy by itself,
the way a phone manages its storage. It watches free disk, memory pressure and
every process it started, removes its own leftovers, and asks before anything
else. Open **Resources** from the gauge icon in the sidebar's top bar, to the
right of the machine switcher.

## What Pane watches

Once a minute Pane samples:

- **Free disk** on each volume that holds Pane's data folder, a project's
  worktrees, or the temp folder.
- **Memory pressure**, from each OS's own signal (below).
- **Every process Pane started**, with its memory and CPU, credited to its Pane
  and tab. A process that left its tab (its parent exited) is still credited
  through the `PANE_SESSION_ID`, `PANE_PANEL_ID` and `PANE_INSTANCE` variables
  Pane gives it, so another Pane instance on the same machine never claims it.

Nothing is stored: sizes and samples live in memory and start again when Pane
restarts. A storage scan runs in the background ten minutes after Pane starts,
then daily, when disk reaches the warning level (at most once an hour), and
when you choose Measure now on the Resources page. Resources and the CLI show
the last scan right away and never wait for a new one.

| | Warning | Critical |
| --- | --- | --- |
| Free disk | under 20 GB | under 5 GB |
| Memory, macOS | kernel pressure level 2 (`kern.memorystatus_vm_pressure_level`) | level 4 |
| Memory, Linux | PSI `some avg60` of 10% (`/proc/pressure/memory`) | 30% |
| Memory, Linux without PSI, and Windows | under 10% of memory available | under 5% |

A memory level counts after two samples in a row, so a moment's spike raises
nothing. Change the disk figures in Settings › Machine health.

## What Pane may delete

Every item belongs to one tier, and the tier decides whether Pane acts alone,
asks, or only shows it.

| Tier | Items | Rule |
| --- | --- | --- |
| 1 · automatic | Rollback copies and staged app copies of an update that a newer completed update replaced (the newest completed one always stays); Pane's own database migration backups once 30 days old and the database has opened cleanly since; archive cleanup jobs that failed (retried once a day) | Pane made it and nothing can use it now. Runs after each storage scan. Each run is listed under Recent cleanups. |
| 2 · ask | Finished Panes (PR merged or closed, folder missing, or idle 14 days); folders at an archived Pane's path that git confirms were its worktree; agent temp folders of Panes that are gone, and agent temp items nobody touched for 2 days; scratch of paused Panes; pausing idle Panes under memory pressure; processes that left a Pane's tab; stopping or restarting a leaking process | A card or Resources lists each item with its size and reason. Archiving finished Panes, clearing agent temp, clearing paused scratch, removing archived Panes' folders and pausing idle Panes each have a switch in Settings › Machine health to do it automatically; every switch ships off. Pane never stops a process unless you choose to. |
| 3 · show only | Worktrees Pane did not create; files in Pane's data folder Pane did not write (such as database copies made by repair agents); other tools' data (`~/.claude`, `~/.codex`, npm cache, pnpm store, Xcode simulators); WSL disk images | Shown with size, owner and the command that frees it. Pane never deletes them, and `runpane machine cleanup` refuses them. |

Before it touches anything, Pane checks again, right then:

- It skips a Pane that is pinned, is the one you are looking at, has an agent
  working or waiting on you, has an open approval, or has uncommitted changes
  (agent setup folders such as `.claude/` don't count). A WSL Pane is checked
  inside its distro.
- It skips any folder a running process is working in.
- It skips an item it cannot check, such as when git or the process list fails,
  and says why.
- It checks again that the item still belongs to whom the scan said: an agent
  temp folder a newer Pane now uses, or a folder created at an archived Pane's
  path after it was archived, is skipped.
- It stops a process only if its pid and start time still match what Pane
  saw, so a reused pid is never hit.

Deleting first moves the item into a `.pane-trash` folder beside it, after
keeping any agent transcripts in it as archive does. The delete then finishes
in the background. If Pane stops mid-delete, the item is either still in place
or in the trash, never half-removed, and the next start empties every
`.pane-trash`. Freed space is measured from free disk before and after, so it
is what the disk really got back.

Archiving a finished Pane goes through the normal archive: its branch stays
and Restore brings it back. A deleted file is gone once the delete finishes.

## Cards

Pane raises five cards in Approvals, and inside the Pane window as a dialog.
Each lists every item its action covers; Review in Resources lets you choose
item by item.

- **Disk almost full**, with what Pane can free and Clean up.
- **Memory is tight**, with what uses the most memory and Pause idle Panes
  (Panes idle 2 hours, with the same skips as auto-pause).
- **A process keeps using more memory**, when one Pane process grew at least
  500 MB and 50% across the last 30 minutes and set a new high in every
  5-minute slice, named with its Pane and tab. Restart it (for a run script),
  Stop it, or Ignore for this process. On macOS Pane measures the memory footprint, as Activity Monitor
  does, because macOS compresses and swaps memory out of a process's resident
  size.
- **Archive finished Panes**, each with why it is finished, or why it is
  skipped.
- **Processes left behind**, when processes that left their tab belong to an
  archived or paused Pane: each with its name, command, Pane and memory. Stop
  them, or Keep them and Pane does not ask about those processes again.

  A program started with `&` in a Pane terminal stops when its Pane is paused
  or archived, as when you close a terminal. Programs that detach from the
  terminal (tmux, a database, an editor) keep running and reach this card. On
  macOS, Pane cannot read the variables of system programs such as `/bin/sleep`,
  so it does not credit those to a Pane.

A card shows once and again only after 6 hours or when it gets worse; Not now
holds it for 24 hours. When disk or memory turns critical, a desktop
notification also fires, following your notification settings. Ask an agent,
on a card or on Resources, hands the items to the agent of a Session named
"Clean up <machine>", starting that Session when none is open, and shows it.
The agent runs on the machine the window is on when the items are about that
machine, and on this computer otherwise (the window switches back to it).

## Other machines

The Resources header switches between this computer and every machine you
linked. Each machine samples itself; Resources reads it over the link, and a
cleanup you start runs on that machine, through its own checks, and its
buttons say "Runs on" that machine. A machine on an older Pane shows "Update
Pane on this machine to see its health", and an offline machine keeps its last
numbers with their age, with its buttons off. Each machine's cards also show
on every linked machine, titled with their machine's name.

## For agents

```sh
runpane machine health --json                 # levels, volumes, Pane processes and the tiered inventory
runpane machine cleanup --kind agent-temp     # dry run: what would go, with sizes
runpane machine cleanup --kind update-snapshot --yes
```

Clean up only through `runpane machine cleanup`: it applies the same tiers and
checks as the app, and it refuses tier 3. `--yes` on a tier 1 kind needs no
one's OK. For a tier 2 kind, show the person the dry-run list and total first,
and run `--yes` only after they agree. The MCP tools are `machine_health`
and `machine_cleanup` (toolset `machine`). Put QA roots, test instances and
downloads in the Pane's scratch folder (`$PANE_SCRATCH_DIR`) so they go when
the Pane is archived.

## Per operating system

| | macOS | Windows | Linux | WSL projects |
| --- | --- | --- | --- | --- |
| Memory signal | kernel pressure level | available memory | PSI, else MemAvailable | the Windows host's |
| Process memory | footprint for leaks, resident size elsewhere | working set | resident size | resident size, read inside the distro |
| Deleting `node_modules` frees | only blocks that changed: Pane clones node_modules with APFS, so the listed size is an upper bound | its full size | its full size (less on btrfs or XFS reflinks) | space inside the WSL disk image |

The WSL disk image (`ext4.vhdx`) grows and does not shrink by itself. Resources
lists it in tier 3 with its size. To shrink it, run `wsl --shutdown`, then
compact the disk as Microsoft documents (`Optimize-VHD`, or `diskpart` with
`compact vdisk`). Pane never runs these steps.

## Testing

`PANE_AGENT_TEMP_DIRS` (a path list) replaces the agent temp folders Pane
reads, and `PANE_MEMORY_PRESSURE_TEST_LEVEL` (`ok`, `warning` or `critical`)
sets the memory level one Pane instance reads, without signalling every app on
the machine. Use them only with an isolated `PANE_DIR`.
