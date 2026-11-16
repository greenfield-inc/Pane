# Program status (OSC 7501)

Any program running in a Pane terminal tab can tell Pane what it is doing by
printing one escape sequence. Pane shows that state as the tab's status cue
(the dot on the tab and in the sidebar), the same cue it reads from an agent's
screen. A build, a deploy script or an
agent that prints the sequence shows working, blocked or done in Pane with no
Pane-specific rules.

The sequence is the Program Status Protocol, revision 0.4, published by
Superlogical, which makes the Rex terminal:
<https://www.superlogical.com/rex/docs/build/program-status>. The example below
is the spec's own and needs bash or zsh (`\e` is not POSIX `printf`).

```sh
status() {
  printf '\e]7501;state=%s:msg=%s\e\\' "$1" "$(printf '%s' "$2" | base64 | tr -d '\n')"
}
status working "Syncing photos"
rsync -a ~/Photos backup:/photos && status done "Photos synced" || status error "rsync failed"
```

## What Pane shows

| `state` | Tab status cue |
| --- | --- |
| `working` | Working. |
| `blocked` | Blocked: a red dot, plus a desktop alert and a phone alert when the tab becomes blocked. In an agent tab, also `agent.blocked` in the Session journal. `msg` is the prompt line; `kind` (`permission`, `question`, `auth`) is in the status reason. |
| `done`, `error` | Finished. The tab shows the done cue until you open it. The record itself ends when you type in the tab. |
| `idle` | Idle. |
| `clear` | Removes the record, and the tab goes back to reading its screen. |

The status reason is `program_status:<state>`, with `:<kind>` for blocked
(for example `program_status:blocked:auth`).

A program can report several records with `id` (`build`, `build/test`). The tab
shows the most urgent: blocked, then working, then error, done and idle; the
latest one wins within a state. `app` is inherited from the nearest parent
record.

## Precedence and lifetime

A report outranks Pane's screen parsing and its output heuristics while the
record lasts. When no record is left, the tab reads its screen again.

- `working`, `blocked` and `idle` end when the program exits: Pane's own shell
  is back in the foreground. A full reset (`ESC c`) or a new shell prompt
  (OSC 133 `A`) ends them too.
- `done` and `error` stay after the program exits and end when you type in the
  tab.
- On Windows, in WSL, and with the separate PTY host setting on, Pane cannot
  see the foreground process, so records last until the program replaces or
  clears them.

## Rules Pane follows

- Pane reads reports in a terminal's own output only, so a program can change
  only the tab it prints in.
- A malformed pair is skipped. A report without a known `state`, with a bad
  `id`, with base64 that does not decode, with control characters in `msg` or
  `title`, or over the spec's size limits changes nothing.
- Pane removes direction overrides and invisible formatting from `msg` and
  `title` before showing them.
- Pane answers the feature-detection query `ESC ] 7501 ; ? ESC \` with
  `ESC ] 7501 ; ? ESC \`. The reply repeats the query, as the spec defines.
- `progress` is accepted and not shown.

The parser is `main/src/services/agentStatus/programStatus.ts`.
