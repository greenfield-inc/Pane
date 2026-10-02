# Plan: make runpane easier for Session orchestrators

Source brief: [`pane-cli-orchestrator-improvements.html`](./pane-cli-orchestrator-improvements.html)
(48-PR BloomText refactor, written 2026-09-27). The brief's addendum ("issues found after this brief
was written") is also covered here.

Baseline: `pane-session-management-improvements` = `origin/main` at `61f5cf54` (v2.4.133). The
orchestrator ran runpane 2.4.130. All `file:line` references are against `61f5cf54`.

Status: **approved 2026-09-27.** Tyler accepted every recommendation in §4 (D1–D10). Implementation
starts with PR1 and PR2. See §6 for the open PRs this work overlaps.

## TL;DR

- **10 PRs.**
  - Two small, independent PRs come first: quick fixes and wrapper-launched agent identity.
  - Then create/adopt, Session watch, delivery (two parts), reports and archive.
  - Locks, work items and PR events come last, and each needs a decision from you.
- **The brief's claims:** 23 are confirmed or partly confirmed. Two are not reproducible:
  - "No base branch": the flag exists but isn't findable, and branch names lose `/`.
  - "Most commands reject `--pane-dir`": only offline commands reject it.
- **The most serious finding is new, from the addendum.** A panel launched through a wrapper such as
  agent-farm is never marked as an agent. That one cause breaks four things:
  - composer detection;
  - the submit result, which says `ok: true` when nothing was sent;
  - `panels list`, which shows no agent type;
  - `watch`, which never reports the panel at all.
- **Other bugs found along the way:** 10 more, listed in §2.

---

## 1. Verification of the brief's claims

Status key:
- **C** = confirmed.
- **P** = partly confirmed, or the cause differs from what the brief says.
- **NR** = not reproducible on the baseline.
- **AF** = already fixed.

### Main brief

| # | Brief claim | Status | Evidence and real cause | PR |
|---|---|---|---|---|
| 1a | `panes create` can't choose a base branch | **NR** | `--base-branch` has existed since June (`contract.json:1224`). It flows through `commands.ts:431-437` → `runpane.ts:3292` → `taskQueue.ts:257` → `worktreeManager.ts:387`. But it is hidden behind `[options]` in the usage line (`contract.json:299`), and no skill mentions it. **A discoverability problem.** | 1 |
| 1b | Can't name the branch (`agents/w5a-…`) | **C** (not in the brief) | There is no `--branch`. The branch name is the worktree name, lowercased with everything outside `[a-z0-9-]` removed (`taskQueue.ts:237,240`), so `agents/w5a` becomes `agentsw5a`. This is probably what actually forced `git worktree add`. | 3 |
| 1c | New branches track the base | **P, fixed by open PR #780** | An `origin/*` base uses `--no-track` (`worktreeManager.ts:345-348`). Any other base does not (`:351`). Pool claims always use `--no-track` (`worktreePoolManager.ts:80`), so the result depends on the path taken. | 3 |
| 1d | `adopt` has no prompt input | **C, and worse** | `--prompt` and `--initial-input-file` parse for adopt (flags are global, `commands.ts:244`). They reach the daemon (`runpane.ts:2694`), and then the adopt handler **silently drops** them: `initialState` has no `initialInput` (`runpane.ts:730-736`), and adopt never calls `submitCreateInitialInput`. Adopt also has no `--wait-ready`. | 1 (error), 3 (support) |
| 2a | A long prompt arrived "cut off at the start" | **P** | Nothing drops bytes: a single `pty.write` (`terminalPanelManager.ts:1395-1411`). The fragile parts:<br>• No bracketed paste anywhere in the send path.<br>• Enter is pressed as soon as *any* staged text appears (`runpane.ts:1046-1053`).<br>• `create` prompts go to Claude, Codex and Cursor as a double-quoted argument *typed into an interactive shell* (`terminalPanelManager.ts:270-272, 322-337, 1143`). Only `\ " $ \`` are escaped, so shell history expansion (`!`) and typing during shell startup can mangle them.<br>• For wrapper panels, text and Enter go out in one write (addendum A1b).<br>Needs a repro. | 5a |
| 2b | `verifiedSubmitted: false` while the turn was taken or queued | **C** | For Claude, the check is true only if two polls in a row within 3s show an empty composer (`runpane.ts:2186-2195`, `:170-171`). No transcript is read.<br>• The queued-message hint and non-dim grey suggestions count as held text, because only SGR 2 is blanked (`terminalStateEmulator.ts:146-167`).<br>• `[Pasted text` *anywhere on screen* triggers the "still in the composer" hint (`runpane.ts:2244-2247`). | 5b |
| 2c | Pane already has the transcript | **P** | For Claude, the transcript path is deterministic, because Pane chooses `--session-id` (`terminalPanelManager.ts:309-337`). For Codex, the ID is only scraped from exit text (`:583-619`). No daemon code reads transcripts. The only reader keyed by session ID is `session-trace/scripts/build-trace.mjs:29-53`. | 5b |
| 3a | No structured completion report | **C** | There is no `report` command and no completion hooks. The only structured report is the Session-level `report` (`orchestrationSession.ts:27-33`). | 6 |
| 3b | READY fired for already-finished workers | **P** | A live READY needs a transition from working or blocked to idle (`workspaceJournal.ts:329-331`). But after a daemon restart, a cursor truncation, or `--from earliest`, the baseline replays idle panels as `agent.ready` (`workspaceStateReader.ts:82-90,142-146`). JSON mode prints these as plain `agent.ready` (`watchLines.ts:71`), and the skill arms `--json`. | 4 |
| 4a | Re-arming the watcher on every membership change | **C** | There is no Session filter on the daemon side (`workspaceJournal.ts:30-39`, `runpane.ts:2581-2602`). The skill *requires* one `--pane` per Pane and a re-arm after each change (`skillCacheManager.ts:577-581`, `docs/SESSIONS.md:189-192`). Each re-arm changes the cadence key and can re-deliver lines (`runpane.ts:1214,1278-1290`). | 4 |
| 4b | The `session-<id>` cursor name fails the 64-char limit | **C** | The pattern is at `runpane.ts:182`, the error at `:2573`. A Session ID is 62 characters (`orchestrationSessionManager.ts:158`), so `session-<id>` is 70. The example appears in `skillCacheManager.ts:573,582` and `docs/SESSIONS.md:183,192`, and is locked in by `skillCacheManager.test.ts:324,343`. | 1 |
| 4c | Docs say filter HEARTBEAT, but JSON emits `_heartbeat`, `_ok`, `_reset` | **C** | Emitted at `watchLines.ts:65-72,88-98`. The full set is `_ok _heartbeat _error _reconnected _reset _dropped`. The skill says "Filter HEARTBEAT" (`skillCacheManager.ts:586-587`) while arming `--json`. There is no quiet flag. | 1 |
| 5 | Archive leaves adopted worktrees | **C (by design)** | `worktreeOwnership: 'external'` (`runpane.ts:719`) skips both the safety check and removal (`:796-801`). There is no merged-via-PR evidence (`:3019-3079`). A slow `node_modules` removal shows up as `worktreeCleanup: 'timeout'` with `ok: false` (`:177,863`). | 7 |
| 6 | No locks for shared resources | **C** | Only an in-process mutex exists (`utils/mutex.ts`). Ports are a hash, not an allocation (`terminalPanelManager.ts:947-958`). | 8 |
| 7 | No Session work items | **C** | The ledger is only advice in a skill (`orchestrate-sessions/SKILL.md:84-86`). Sessions live in `orchestration-sessions.json` (`orchestrationSessionManager.ts:77`). | 9 |
| 8 | `--pane-dir` rejected by most commands | **NR (mostly)** | Every daemon command accepts it (`commands.ts:649-690`). It is rejected only by help, setup, install client, update, version and **`agent-context`** (`commands.ts:703`). Most usage lines leave it out. | 1 |
| 9 | Ghost suggestions look like typed text in `panels screen` | **C** | Plain `screenText` with no tagging (`runpane.ts:1798`). Only dim cells are blanked, and only for `hasUndeliveredText`. | 5b |
| 10 | No PR conflict or checks events | **C** | The journal ignores `git-status-updated` (`workspaceJournal.ts:191-244`). There is no `mergeable` or checks fetch (`gitStatusManager.ts:623-627`), and no polling timer. | 10 |
| 11 | adopt returns `paneId: null` | **C, fixed by open PR #771** | The daemon returns `items[].paneId` (`runpane.ts:753-766`). The CLI decoder has no `paneId` on success items (`localControl.ts:1027-1038`), and `boundary.object` drops unknown keys (`boundaryDecoder.ts:179-184`). `panes create` is affected too. | 1 |

### Addendum

| # | Brief claim | Status | Evidence and real cause | PR |
|---|---|---|---|---|
| A1a | Wrapper panel: `composer.isPresent: false` while a `❯` box is visible | **C** | Composer detection runs only for `agentType` `claude` or `codex` (`runpane.ts:1820-1829`). `agentType` comes from custom state or the **first word** of the launch command (`agentIdentity.ts:309-316`, which knows only `claude`, `codex` and `cursor-agent`, `:13-17`). `agent-farm run free-range` resolves to nothing. | 2 |
| A1b | `panels submit` returns `ok: true`, `verifiedSubmitted: false`, no blocked hint, and the text sits unsent | **C** | With an unknown agent, `stagesComposer` is false (`runpane.ts:1040-1041`). The text and `\r` are then written together, and **`ok: true` is hard-coded** (`:1068-1080`). The code's own comment explains the result (`:1026-1028`): Claude reads text and Enter in one read as a paste and keeps the Enter as a newline. | 2 |
| A1c | `submit-composer --strategy auto` didn't send; `--strategy enter` did | **P** | For an unknown agent, `auto` resolves to `enter`, and both send the **same `\r` byte** (`runpane.ts:2104-2119`). The difference was timing (Claude still taking in the paste, or busy), not the strategy.<br>Verification for an unknown agent returns `ok: true` with nothing blocked (`:2173-2175, 2239-2243`), so there was no signal to retry.<br>The "busy with subagents, Enter left the text unsent" case is not explained by the code and needs a repro. | 2, 5a |
| A1d | `hasUndeliveredText: false`, so "resubmit only with proof" can't be followed | **C** | A consequence of A1a. | 2 |
| A2a | `panels list` shows `agentType: null` for the wrapper panel | **C** | `panelToSummary` reads only `customState.agentType` (`runpane.ts:1374-1377`). The wrapper command is never resolved or recorded. | 2 |
| A2b | `panes list` shows `status: "stopped"` while the agent is live | **C (different cause)** | `status` is the stored Pane lifecycle value (`runpane.ts:1350`). `panes adopt` sets it to `'stopped'` (`:722`), and nothing updates it from panel activity. A separate `agentStatus` exists (`:1344,1362-1370`), but it only knows `active` and `idle`. | 2 |
| A3a | `agent-context --command <unknown> --json` prints non-JSON | **C** | `getCommandDetail` throws (`agentContext.ts:69`), and `runAgentContext` has no catch (`:25-36`). The top-level catch prints plain text to stderr and exits 1 (`cli.ts:671-673`). | 1 |
| A3b | Archive `safetyCheck.performed: false` gives no reason | **C** | The external-worktree path returns a bare `{ performed: false }` (`runpane.ts:799-801`). `reasonUnavailable` exists only for a missing project (`:3022`), and `toPublicSafetyCheck` doesn't expose it at all (`:3131-3142`). | 1 |
| A3c | READY can arrive about 13 minutes late when a person is waiting | **C (by design)** | The single documented profile is `--settle 180000` plus `--min-interval 600000`, worst case 13 minutes (`skillCacheManager.ts:573`, contract watch docs). There is no "user present" profile. | 1 (docs) |
| A3d | Busy agent: report `delivery: "queued"` | **C** | Same as 2b. Nothing recognises the queued state. | 5b |

## 2. Other bugs found during verification

1. **Wrapper-launched agent panels can't be seen by `watch`.** `isCliPanel` is set only when the agent
   type resolves (`terminalPanelManager.ts:280-289`). The journal emits `agent.*` only for CLI panels
   (`workspaceJournal.ts:276`), and `--agents-only`, the default under `--follow`
   (`localControl.ts:1575-1577`), also drops entries with no agent type (`workspaceJournal.ts:358`).
   Result: the recommended watcher never reports READY or BLOCKED for an agent-farm worker. (PR2)
2. **`watch --session` is accepted and silently ignored** (`commands.ts:411-413`, `localControl.ts:1585-1605`). (PR1, then PR4)
3. **`watch --all-managed` is a no-op** (`commands.ts:191`). (PR1)
4. **The default follow cursor `PANE_PANEL_ID` is about 91 characters for orchestrator panels**
   (`localControl.ts:1583-1584`, `orchestrationSessionManager.ts:51,64-65`), so it fails validation. (PR1)
5. **STUCK never appears in JSON mode** (`localControl.ts:1579-1580`). (PR1)
6. **`panes create --json` drops `paneId`** (see row 11). (PR1)
7. **The `create` prompt argument is typed into an interactive shell** (see 2a). (PR5a)
8. **The "still in the composer" hint fires on `[Pasted text` anywhere on screen**, including the transcript (`runpane.ts:2244-2247`). (PR5b)
9. **A CRLF prompt file sends Enter on every line** (`runpane.ts:1024`). (PR5a)
10. **Declaring the agent behind a wrapper isn't possible.** `--agent` and `--tool-command` are
    mutually exclusive (`localControl.ts:2243`). Setting `customState.agentType` for a wrapper command
    would also make `resolveCliLaunch` rewrite that command as if it were `claude`
    (`terminalPanelManager.ts:280-292`). (PR2)

## 3. PR sequence

```
PR1 quick fixes ──┬─ PR3 create/adopt ──┐
PR2 wrapper id ───┼─ PR4 session watch ─┼─ PR6 reports ─┬─ PR9 work items (D6)
                  └─ PR5a → PR5b ───────┘               └─ PR10 PR events (D7)
PR7 archive (independent)        PR8 locks (independent, D5)
```

| PR | Title | Items | Size | Depends on |
|---|---|---|---|---|
| 1 | Watch/CLI correctness and doc fixes | 1a, 1d (error), 4b, 4c, 8, 11, A3a-c, §2 bugs 2-6 | S | none |
| 2 | Wrapper-launched agent identity and honest submit results | A1a-d, A2a-b, §2 bugs 1 and 10 | M | none |
| 3 | Create on any branch, adopt with a prompt | 1b-1d | M | 1 (2 for `--agent` with `--tool-command` on adopt) |
| 4 | Session-scoped watch | 4a, 3b | M | 1, 2 |
| 5a | Intact delivery | 2a, A1c (busy case), §2 bugs 7 and 9 | M | 1, 2 |
| 5b | Delivery state from the transcript, ghost text | 2b, 2c, 9, A3d, §2 bug 8 | M | 5a |
| 6 | Worker reports, `agent.report`, `panels last-message` | 3a | M-L | 4, 5b |
| 7 | Archive: `--remove-worktree`, merged-PR evidence, bulk | 5 | M | none (after 3 preferred) |
| 8 | Named locks | 6 | S-M | none (D5) |
| 9 | Session work items | 7 | M | 6 (D6) |
| 10 | PR watch events | 10 | M | 4 (D7) |

Every PR that changes commands or flags does the following:
- Edits `contracts/runpane/contract.json`.
- Regenerates with `pnpm generate-runpane-contract`, which rewrites `docs/RUNPANE_CLI_CONTRACT.md`,
  the TS and Python generated contracts, and `shared/types/generatedRunpaneContract.ts`.
- Passes `pnpm test:runpane-contract`, `pnpm lint`, `pnpm typecheck` and `pnpm --filter main test`.
- Keeps the **Python wrapper** (`packages/runpane-py/src/runpane/local_control.py`) in parity, or
  documents the difference in the contract.

---

### PR1: Watch and CLI correctness, doc fixes (S)

- **Cursor names**
  - Raise `WORKSPACE_CONSUMER_PATTERN` to `{1,128}` (`runpane.ts:182`).
  - The CLI shortens any *derived* cursor name longer than 64 characters (the `PANE_PANEL_ID`
    fallback, and later `--session`) to `<prefix>-<sha256[:12]>`, so it works with older daemons.
  - Fix the examples in the docs.
- **Control lines**
  - Add `--quiet` (alias `--no-control-lines`), which suppresses `_ok`, `_heartbeat` and
    `_reconnected`.
  - `_error`, `_reset` and `_dropped` are always printed.
  - Document every control kind in the contract's watch reference (`contract.json:9226+`) and the skill.
  - Request `includeHeldInputPresence` in JSON mode too, so STUCK has a JSON equivalent.
- **Silent no-ops become errors**
  - `watch --session` fails until PR4.
  - `--all-managed` is wired up or removed.
  - `panes adopt` with a prompt fails until PR3.
- ~~`paneId` in output~~: already done by open PR #771 (audit item 36). Only a regression assertion here.
- **`--pane-dir`:**
  - `agent-context` and `version` accept and ignore it.
  - Usage lines show `[--pane-dir <path>]`.
  - The runtime context (`skillCacheManager.ts:944-945`) says to pass it to every runpane command.
- **`agent-context` errors (A3a):** with `--json`, an unknown command prints
  `{ ok: false, code: "unknown_command", candidates: [...] }`, with candidates ranked by edit distance,
  and exits 2. Without `--json`, the same list is printed on stderr.
- **Archive reason (A3b):** `safetyCheck.reason` is `external-worktree`, `main-repo`,
  `missing-project-context` or `git-error`. The public safety check also gets
  `worktreeWillRemain: true`.
- **Watch profiles (A3c):** the skill, `docs/SESSIONS.md` and the contract document two profiles:
  - **Unattended**, as now.
  - **User present:** `--settle 60000 --blocked-settle 15000 --min-interval 120000`, with no
    `--idle-backoff`. Worst case 3 minutes.
- **Discoverability:** `--base-branch` appears in the `panes create` usage line and the skill.
- **Tests:**
  - Contract parser samples for `--quiet`, the `--pane-dir` matrix, and the `agent-context` JSON error.
  - `runpane.test.ts`: consumer names of 70 to 128 characters, and `reason` on the external archive.
  - `skillCacheManager.test.ts:324,343` updated.
- **Compatibility:** additive, except that the `agent-context` error moves to JSON on stdout when
  `--json` is set.

**PR1 status: implemented** on `pane-session-management-improvements`. Plan deltas:
- `panes adopt` with a prompt still passes silently; that error moved to PR3, which implements the
  support in parallel.
- `--all-managed` stays. It is the explicit spelling of the default scope (every non-archived,
  non-hidden managed Pane) and still conflicts with `--pane`; its docs now say so.
- The cursor-shortening helper (`derivedWatchCursorName`, `derived_watch_cursor_name`) is
  module-private in `localControl.ts` / `local_control.py`. Knip rejects an unused export, and
  PR4's `--session` default lives in the same `runWatch`.
- `--quiet` is rejected outside `watch`. `--self-test` still prints its WATCH OK result under
  `--quiet`.
- Skipping cleanup for a Pane with no repository also reports `missing-project-context` with
  `worktreeWillRemain: true`. The internal `reasonUnavailable` field is gone, because `reason`
  replaces it.

### PR2: Wrapper-launched agent identity and honest submit results (M)

The addendum's P1 and P2. This PR does not depend on the others, and it fixes watch for wrapper
workers too.

- **Resolve the agent behind a wrapper.** The panel's agent type is decided in this order:
  1. **Declared:** allow `--agent` *together with* `--tool-command` on `panes create`, `panes adopt`
     and `panels create`. `--agent` then means "the agent this command runs".
  2. **Launch command:** today's behaviour.
  3. **Foreground process:** node-pty's `pty.process` gives the foreground process name on POSIX.
     `claude`, `codex` and `cursor-agent` map to an agent. Checked on the existing status poll
     (`terminalPanelManager.ts:1749-1771`) until resolved. **Spike:** confirm the process name Claude
     Code reports under agent-farm.
  4. **Screen signature:** Claude's rule/`❯`/rule composer box, and Codex's header and `›` prompt.
     Match twice in a row to avoid false positives.
- **Store it on the panel**
  - Record `agentType`, `agentDetection: 'declared' | 'command' | 'process' | 'screen'` and
    `launchCommand` in the panel's custom state.
  - Set `isCliPanel: true`, and switch the status manifest to the detected agent.
  - Add `launchMode: 'wrapped'`, so that `resolveCliLaunch` (`terminalPanelManager.ts:280-292`)
    **does not** rewrite a wrapper command into a `claude --session-id …` command. This fixes §2 bug 10.
- **What changes for callers:**
  - The journal emits `agent.*` for these panels, fixing §2 bug 1.
  - `panels list` returns `agentType`, `agentDetection` and `launchCommand` (A2a).
  - Submit uses the detected agent's staging and strategy.
- **Honest submit (A1b)**
  - When a panel is (or looks like) an agent but no composer can be found, `panels submit` returns
    `ok: false, blocked: { kind: 'composer-unknown' }` instead of the hard-coded `ok: true`
    (`runpane.ts:1068-1080`).
  - Plain shells keep today's write-and-`ok` behaviour, but only when the foreground process is a shell.
- **`submit-composer --strategy auto` fallback (A1c):** if the staged text is still visible after the
  first attempt, send one plain `\r` and check again. The visible text proves it wasn't delivered, so
  this can't double-send.
- **Pane status (A2b, decision D9)**
  - `panes list` `status` comes from live panels: any initialized terminal gives `running`, otherwise
    the stored value.
  - `agentStatus` gains `ready`, `working`, `blocked` and `none`.
  - `panes adopt --launch` stops writing `'stopped'` (`runpane.ts:722`).
- **Tests:**
  - `terminalPanelManager` tests: wrapper with declared agent, process detection, screen detection,
    and no rewrite of the command under `launchMode: 'wrapped'`.
  - `runpane.test.ts`: submit to an undetected agent gives `composer-unknown`; submit to a detected
    wrapper agent stages and verifies; the auto fallback; `panes list` status for an adopted, live
    Pane.
  - `workspaceJournal.test.ts`: wrapper panel entries survive `agentsOnly`.
- **Docs:** contract `panels list` and `panes list` schemas, `panes adopt`/`panels create` usage
  (`--agent` with `--tool-command`), the runpane skill, and `docs/IMPLEMENTING_NEW_CLI_AGENTS.md`
  (a wrapper section).

### PR3: Create on any branch, adopt with a prompt (M)

- **`panes create --branch <ref>`**
  - A full branch name, `/` included, checked with `git check-ref-format --branch`. It is separate
    from `--worktree-name`.
  - Threaded through `taskQueue.createSessionAndWait` → `worktreeManager.resolveWorkingDirectory` →
    pool claim (`worktreePoolManager.ts:170-180`).
  - Fails if the branch already exists; it is never made unique silently.
- **`--base <ref>`** is an alias for `--base-branch`.
- ~~`--no-track` on every `git worktree add -b`~~: already done by open PR #780. Only add a test here.
- **`panes adopt --prompt | --prompt-file | --initial-input-file | --wait-ready | --ready-timeout-ms`**
  - Only valid with `--launch`.
  - Reuses `createTerminalPanelForSession` (`runpane.ts:1414-1473`), extended with a resume
    `agentSessionId`, instead of the separate `initialState` (`:730-736`).
  - Also works with PR2's `--agent` plus `--tool-command`.
- **`--prompt-file`** is an alias for `--initial-input-file`.
- **Tests:** `--branch agents/x` off `release/foo` keeps its name and has no upstream; a non-origin
  remote base doesn't track; adopt `--launch --prompt-file` delivers; a prompt without `--launch`
  errors.
- **Docs:** create and adopt usage and help; the orchestrate-sessions skill ("create replaces
  worktree add plus adopt").

### PR4: Session-scoped watch (M)

- **`runpane watch --session <id|name> --follow`**
  - Adds `sessionId` to `WorkspaceJournalFilter` (`workspaceJournal.ts:30-39`).
  - `matchesFilter` resolves membership **at read time**, so associate and detach need no re-arm.
  - Archived and detached Panes drop out.
  - The cadence key is `session:<id>` (`runpane.ts:3616-3623`), so held state survives membership
    changes.
- **New kinds `pane.associated` and `pane.detached`,** emitted by the Session manager through the
  journal.
- **Default cursor:** `session-<uuid>`, 44 characters.
- **The Session's own orchestrator panel is excluded.**
- **Baseline replay (3b):** baseline and reset entries get `replay: true` in JSON, and the skill says
  replay is never READY (D3).
- **Tests:** a live membership filter, a stable cadence key, the replay flag.
- **Docs:** replace the "one `--pane` each, re-arm after associate" text (`skillCacheManager.ts:573-583`,
  `docs/SESSIONS.md:183-192`) with one command that uses `--session --follow --quiet --json`.

**PR4 status: implemented** on `runpane/session-watch` (stacked on PR1). Plan deltas:
- The Session manager's existing `changed` event now carries `paneIds` and `sessionName` for
  associate/detach; the journal reads it and appends `pane.associated`/`pane.detached` (lines:
  `JOINED`/`LEFT <pane> pane <id> session <session-id>`). Re-associating a member emits nothing.
- The new kinds reach a watcher only under `--session` or when `--kinds` lists them, so older CLIs
  (whose decoders reject unknown kinds) never receive them.
- The wait result echoes `session: { id, name }`; the CLI fails the watch when a daemon ignores
  `session`, instead of silently watching every Pane.
- An association limited to `panelIds` reports only those panels (as `sessions overview` does), and
  a held cadence line for a Pane detached before it flushed is dropped.
- `--session` also conflicts with `--all-managed`. A name gives the cursor `session-<name>`
  (hash-shortened when not portable), since the CLI resolves nothing itself.

### PR5a: Intact delivery (M)

- **Bracketed paste**
  - Multi-line or long (more than 512 characters) text to Claude or Codex composers is wrapped in
    `\x1b[200~ … \x1b[201~` (`runpane.ts:1044`, `:1558-1654`).
  - CRLF is normalised to LF first.
  - Enter waits for the paste to settle: the marker or the text, plus a quiet window.
- **Busy agents (A1c):** Enter is sent as its own write only after the staged text is visible, even
  while the agent is working. Claude queues a separately received Enter. **Needs a repro against a busy
  wrapper panel once PR2 lands.**
- **No more prompts typed into the shell (D1):** long or multi-line `create` prompts are written to
  `<paneDir>/prompts/<paneId>/<ts>.md` and launched with `"$(cat '<path>')"` on POSIX. PowerShell and
  cmd use composer paste.
- **`--as-file-pointer`** on `panels submit`, `agents send`, `panes create` and `panes adopt`: Pane
  writes the file and submits `Read and follow <path>`. The result includes `promptFile`.
- **Leading `!`, `#`, `/` and `@` for Claude** produce a warning field, and the text is left alone.
- **Tests:** paste wrapper, CRLF, Enter timing, file pointer, file-substitution in the launch command.

### PR5b: Delivery state from the transcript, ghost text (M)

- **A new `main/src/services/agentTranscript/` reader**
  - Claude: `~/.claude/projects/<encoded cwd>/<agentSessionId>.jsonl`, tailed from a byte offset.
  - Codex: the newest rollout whose `session_meta.cwd` matches the worktree (reusing
    `build-trace.mjs:29-53`).
  - API: `findUserTurnSince`, `lastAssistantMessage`.
- **`delivery` field:**
  `delivery: { state: 'taken' | 'queued' | 'in-composer' | 'unknown', evidence: 'transcript' | 'screen' | 'argv' }`
  - Queued (A3d): the queued-message hint on screen, or the transcript's queue entries (**spike**).
  - The transcript is polled for about 10s.
  - `verifiedSubmitted` stays, derived as `taken || queued`.
  - The "still in the composer" hint fires only for `in-composer`, which fixes §2 bug 8.
- **Ghost text (9):**
  - Cells with a grey or placeholder foreground are blanked and tagged, as well as SGR 2 ones
    (`terminalStateEmulator.ts:146-167`).
  - `panels screen --json` adds `composer.ghostText`, and text output marks the line `⟨suggestion⟩`.
- **Tests:** transcript fixtures (taken and queued, for Claude and Codex); screen fixtures for grey
  queued hints and suggestions; rewrite the stale `runpaneVerification.test.ts`.

### PR6: Worker reports, `agent.report`, `panels last-message` (M-L)

- **`runpane report --state ready|blocked|failed|done [--pr <n>] [--head <sha>] [--summary <text> | --summary-file <path|->] [--question <text>]`**
  - Identity comes from `PANE_SESSION_ID` and `PANE_PANEL_ID` (`terminalPanelManager.ts:992-1007`),
    or from `--pane` and `--panel`.
  - `--question` is required when blocked.
- **Daemon**
  - Stores the latest report per panel in the panel's custom state, keeping up to 16k characters of
    summary.
  - Adds it to Session activity, and to `sessions overview` under `panes[].report`.
- **Journal kind `agent.report` (D2)**
  - Carries `{ state, pr, head, summaryPath, question }`.
  - Printed as `REPORT <pane> ready pr#747 fc5dce9`.
  - Bypasses `--min-interval`.
- **`panels last-message --panel <id> [--json]`** uses the PR5b reader. With no transcript it returns
  `transcript-unavailable`; it never scrapes the screen.
- **Skill changes:** worker prompts end with a `runpane report` line, and the orchestrator treats
  `agent.report` as the completion signal.

### PR7: Archive removes adopted worktrees, with merged-PR evidence (M)

- **`panes archive --remove-worktree`** opts an external Pane into `computeArchiveSafety` and removal
  (`runpane.ts:796-801`).
- **Merged evidence**
  - With no upstream, or an upstream that is gone, run
    `gh pr list --head <branch> --state merged --json number,headRefOid`.
  - If `headRefOid` equals `HEAD`, set `safetyCheck.mergedViaPr` and don't count those commits as
    unpushed. This applies to managed Panes too.
- **Fast removal:** rename the directory into `<repo>/.git/pane-trash/<id>`, run
  `git worktree prune`, and delete in the background. Report `worktreeCleanup: 'removed' | 'queued'`
  instead of `'timeout'` with `ok: false`.
- **Bulk:** `panes archive --session <id> --merged [--dry-run]`, with a result and a reason per Pane.
- **Local branches are kept (D4).**

### PR8: Named locks (S-M, D5)

- **Commands:** `runpane lock acquire <name> --ttl <dur> [--wait <ms>]`, `lock release`, `lock list`.
- **Owner:** the Pane and panel from the environment. A lock is released automatically on TTL, panel
  exit, or archive.
- **Scope:** per Session.
- **Storage:** `<paneDir>/locks.json`, written with temp-and-rename.
- **Visibility:** held locks appear in `sessions overview`.

### PR9: Session work items (M, D6)

- **Commands:** `runpane sessions items add|update|list|remove`.
- **Fields:** `{ id, title, phase?, paneId?, branch?, pr?, state, notes?, updatedAt }`.
  - PR state is filled in from `gitStatusManager`.
  - An `agent.report` updates the linked item.
- **Storage:** a separate `orchestration-session-items.json`. `boundary.object` drops unknown keys, so
  an older binary would erase an `items` field in the Session file.

### PR10: PR watch events (M, D7)

- Every 3 minutes, poll only Session-member Panes that have an open PR.
- The call is `gh pr view --json mergeable,mergeStateStatus,statusCheckRollup,state`.
- It emits `pr.conflicted`, `pr.checks` and `pr.merged`, on transitions only.

**PR10 status: implemented** on `runpane/pr-watch-events` (stacked on PR4) as
`main/src/services/sessionPrMonitor.ts`, sharing GitStatusManager's one-at-a-time `gh` slot. Plan
deltas: the first poll of a PR seeds silently (a daemon restart restates nothing); `pr.checks`
fires once every check on the head finishes (`passed`/`failed`, up to five failing names);
`pr.conflicted` and failed `pr.checks` bypass `--min-interval`; no `pr.closed` or
`pr.conflict-resolved` kinds; the PR kinds are opt-in like JOINED/LEFT. A member with no known open
PR is looked up by branch each round through GitStatusManager's `gh pr list --head` path, so
unwatched workers' new and reopened PRs are found; `mergeStateStatus` is not fetched (unused).

---

## 4. Decisions (accepted 2026-09-27: all recommendations)

| # | Decision | Recommendation |
|---|---|---|
| D1 | How long `create` and `adopt` prompts reach the agent | Write the prompt to a file and launch with `"$(cat file)"` on POSIX, with composer paste elsewhere. `--as-file-pointer` stays opt-in. |
| D2 | `agent.done` (brief) or `agent.report` with a `state` field | `agent.report`. It also carries blocked and failed, and "done" would clash with READY. |
| D3 | Baseline replay in JSON: flag it, or drop idle panels | Flag it with `replay: true`. |
| D4 | Should `--remove-worktree` / `--merged` delete the local branch? | No. It is the recovery path. |
| D5 | Build locks, or rely on a prompt convention? | Build them, after PRs 1–7. |
| D6 | Build work items, or rely on reports plus overview? | Wait until after PR6 ships, then revisit. |
| D7 | Should the daemon poll GitHub for PR events? | Yes, but only for Session members with open PRs, every 3 minutes. |
| D8 | Cursor limit: raise to 128, or hash? | Both: the daemon accepts 128, and the CLI hashes derived names. |
| D9 | What `panes list` `status` means for a live adopted Pane | Derive it from live panels (`running` while any terminal is live), and richer `agentStatus`. Keep the field name. |
| D10 | Agent detection for wrappers: may Pane scan the process and screen, or only use `--agent`? | Allow all three (declared, then process, then screen), and record which one was used in `agentDetection`. |

## 5. Out of scope

- The brief's "what I'd do differently" table is orchestrator practice. PR1 folds its "one-line
  pointer" and "wait for your lock" advice into the skill.
- Port hash collisions (`terminalPanelManager.ts:947-958`). Track separately.

## 6. Overlap with open PRs (checked 2026-09-27)

No open PR implements any of these PRs, so each one becomes a **new PR from `main`**. Several open
PRs touch the same files, though:

| Open PR | Covers or conflicts with | Action |
|---|---|---|
| #780 `audit-fix/git-arguments` | 1c: `--no-track` everywhere; rewrites `worktreeManager` and the pool to argv | Drop 1c from PR3. Build `--branch` on top of #780's argv form. |
| #771 `audit-fix/wrapper-correctness` | 11: create/adopt JSON keeps `paneId`, `tool` and `focused` | Drop 11 from PR1. |
| #818 `split/session-auto-associate` (Tyler, draft) | Auto-association on create and adopt. Edits the skill, `SESSIONS.md` and the contract that PR1, PR3 and PR4 also edit | Merge before PR1/PR3, or rebase them after it. |
| #819 `split/session-workspace`, #793 `audit-fix/agent-catalog` | `agentIdentity.ts`, `terminalPanelManager.ts` | PR2 rebases after them; land them first if possible. |
| #790 `audit-fix/terminal-lifecycle`, #760 `audit-fix/workspace-journal` | `workspaceJournal.ts` and journal bootstrap | PR2 and PR4 rebase after them. |
| #762 `audit-fix/wrapper-requests` | adopt request parsing | PR3 rebases after it. |
| #788 `audit-fix/cli-dispatch`, #791, #795 | contract-driven CLI dispatch and Python parity | PR1 adds commands and flags the way #788 does, once it merges. |

## 7. Implementation PRs (2026-09-27, all draft)

| Plan PR | GitHub | Branch | Base |
|---|---|---|---|
| PR1 quick fixes | #829 | `pane-session-management-improvements` | `main` |
| PR2 wrapper agent identity | #831 | `runpane/wrapper-agent-identity` | `main` |
| PR3 create/adopt | #830 | `runpane/create-branch-adopt-prompt` | `main` |
| PR4 Session watch | #833 | `runpane/session-watch` | #829 |
| PR5a intact delivery | #836 | `runpane/intact-delivery` | #831 |
| PR5b delivery state | #837 | `runpane/delivery-state` | #836 |
| PR6 reports | #839 | `runpane/worker-reports` | #837 |
| PR7 archive | #832 | `runpane/archive-remove-worktree` | `main` |
| PR8 locks | #834 | `runpane/named-locks` | `main` |
| PR9 work items | deferred (D6) | | |
| PR10 PR events | #835 | `runpane/pr-watch-events` | #833 |

Combined PRs (for review, stacked):

| Combined PR | Replaces | Branch | Base |
|---|---|---|---|
| Part 1: Session watch | #829, #833, #835 | `runpane/combined-session-watch` (#844) | `main` |
| Part 2: agent delivery and reports | #831, #836, #837, #839 | `runpane/combined-agent-delivery` (#845) | #844 |
| Part 3: create/adopt, archive cleanup, named locks | #830, #832, #834 | `runpane/combined-pane-lifecycle` (#846) | #845 |

Suggested merge order:
1. #780, #771 and #818 first.
2. Then #829 → #833 → #835.
3. Then #831 → #836 → #837 → #839.
4. #830, #832 and #834 can merge whenever they're ready.

Every PR edits `contract.json` and `runpane.ts`. Resolve conflicts by regenerating the contract, and
reconcile the lists of opt-in journal kinds from #833, #835 and #839. Each PR's body has its own
merge notes.
