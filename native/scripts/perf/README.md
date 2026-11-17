# Measuring the phone app

A perf build of the app, a bundle built with `EXPO_PUBLIC_PANE_PERF=1`, logs one line per timing mark, `[perf] <journey> <mark> <ms>`, with the milliseconds since the journey began (`src/features/perf/`). Every other build, OTA updates included, logs nothing and does no timing work. These scripts seed two hosts, run the journeys on an iOS simulator, and turn the logs into the target table, so every change shows the same numbers before and after.

## Journeys and marks

| Journey | Starts | Marks |
|---|---|---|
| `launch` | the bundle loads | `home-frame`, then the connection marks below |
| `return` | the app comes back from the background | `first-frame`, then the connection marks |
| `switch` | another machine's client starts | `home-frame`, then the connection marks |
| `session`, `terminal`, `chat`, `approval` | the screen mounts (an approval again on Next) | `first-frame`, `data`, `content`, `screen`, `messages`, `live`, and where the approval card, tab strip and tab body sit (`card=`, `tabs=`, `body=<y>+<height>`, `workspace=<kind>`) |

The connection marks are logged on every connection journey still under 30 s old:

- `send=<channel>#<args>@<machine>` and `read=…` for each read, and `write=<channel>@<machine>` for anything else. The machine and the arguments are four-character hashes, never names, so the same read sent twice has the same key.
- `stream-request@…` and `stream-open@…`, `status=<status>`, `restored=workspace-lists` and `terminal-screen`.
- `counts=<needs>/<working>/<ready>/<all>` when Home's counts change.
- `<screen>-live` (Home, chat or terminal undimmed and taking input) and `<screen>-fresh` (live, with its data read since the journey began).

A perf build also logs `[perf] app stall <ms>` for every JavaScript gap over 100 ms.

## Run it

From the repo root, with the Mac quiet (check `uptime`):

```bash
pnpm run build:main && pnpm --filter runpane build
export PANE_SCRATCH_DIR=<scratch folder>          # everything goes in $PANE_SCRATCH_DIR/perf.noindex
native/scripts/perf/hosts.sh seed                 # once: A gets 68 Panes and a 200-message Session chat, B 12 Panes; then a snapshot
```

Every start of the hosts (`up`, `seed`, `reset`) also asks 7 approvals from Panes on A and fills a terminal past the 2,500-line cap, since neither survives a restart. The hosts keep their own data folders and browser profile, send no analytics, and never get push keys, so nothing reaches a real phone.

Serve the app's JavaScript in production mode as a perf build, for example a dev client with `EXPO_PUBLIC_PANE_PERF=1 CI=1 npx expo start --dev-client --no-dev --minify --clear --port 8251` from `native/`. Pair the simulator with host B first and host A last, so A is the machine the phone is on:

```bash
maestro --device <simulator> test -e METRO_PORT=8251 \
  -e B_CODE="$(cat $PANE_SCRATCH_DIR/perf.noindex/hostB.phone-code)" \
  -e A_CODE="$(cat $PANE_SCRATCH_DIR/perf.noindex/hostA.phone-code)" native/.maestro/perf-pair.yaml
```

Then run the journeys and make the table:

```bash
UDID=<simulator> LAUNCH_URL='exp+pane://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8251' \
  native/scripts/perf/journeys.sh <out-dir>           # or name scenarios: return-pane-terminal cold-launch …
node native/scripts/perf-table.mts --runs 5 <out-dir>/*.log
native/scripts/perf/hosts.sh down
```

Before each scenario `journeys.sh` resets the hosts to the snapshot (`hosts.sh reset`; `NO_RESET=1` skips it), so a scenario measures the same fixture whether it runs alone or in a full column, and puts the phone on Perf-A with All showing, or stops. It exits with an error when a scenario logs none of the marks it is there to measure. Each scenario runs `RUNS` times (5); `perf-table.mts --runs 5` warns about a journey whose count is not a multiple of 5. `open-approval` and `switch` start two journeys per run (an approval, then Next; Perf-B, then Perf-A), so they show 10. A return stays away `AWAY_S` seconds (10) and changes something on the host meanwhile: a new Pane for Home, a chat message, terminal output. Record `uptime` with the numbers: a loaded Mac slows everything.

| Scenario | Targets |
|---|---|
| `return-session-chat`, `return-pane-terminal` | T1: `chat live`, `terminal live`, reads sent again, terminal handshakes |
| `return-home` | T2: `home fresh` |
| `cold-launch` | T3 to T6: `home frame`, `home fresh`, count changes, wrong counts shown |
| `open-terminal`, `reopen-terminal` | T7: first open from a fresh launch, and a revisit |
| `open-session-chat`, `reopen-session-chat` | T8 |
| `open-approval` | T9: layout final, layout changes (approval 2 of the seeded ones, then Next) |
| `switch` | T10: the machine pills, Perf-B then Perf-A |
| any | T12: stalls over 100 ms |

Every scenario starts from a fresh launch, and a reopen goes back with the screen's own back button, so earlier screens never stay mounted underneath. Navigation goes through Maestro, which answers iOS's "Open in Pane?" prompt; its accessibility snapshots can pause the app, so read stalls from the `return-*` and `cold-launch` scenarios.

On a phone, a perf build's lines are in the device's log: Console.app with the phone connected, filtered on `[perf]`. A loopback host cannot stage a relay or a same-network address that stops answering; those paths are covered by unit tests and by a run on a phone.
