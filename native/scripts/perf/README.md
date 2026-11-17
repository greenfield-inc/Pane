# Measuring the phone app

The app logs one line per timing mark, `[perf] <journey> <mark> <ms>`, with the milliseconds since the journey began (`src/features/perf/`). These scripts seed two hosts, run the journeys on an iOS simulator, and turn the logs into the target table, so every change shows the same numbers before and after.

## Journeys and marks

| Journey | Starts | Marks |
|---|---|---|
| `launch` | the bundle loads | `home-frame`, then the connection marks below |
| `return` | the app comes back from the background | `first-frame`, then the connection marks |
| `switch` | another machine's client starts | `home-frame`, then the connection marks |
| `session`, `terminal`, `chat`, `approval` | the screen mounts (an approval again on Next) | `first-frame`, `data`, `content`, `screen`, `messages`, `live`, `card=<y>+<height>`, `workspace=<kind>` |

The connection marks are logged on every connection journey still under 30 s old: `send=<channel>@<machine>` and `read=<channel>@<machine>` for each read (the machine is the first six characters of its profile id), `stream-request@…` and `stream-open@…`, `status=<status>`, `restored=workspace-lists`, `terminal-screen`, `counts=<needs>/<working>/<ready>/<all>`, and `<screen>-live` and `<screen>-fresh` (Home, chat or terminal at full strength with input enabled; fresh also needs its data read after the journey began). A bundle built with `EXPO_PUBLIC_PANE_PERF=1` also logs `[perf] app stall <ms>` for every JavaScript gap over 100 ms.

On a phone, the lines are in the device's log: Console.app with the phone connected, filtered on `[perf]`.

## Run it

From the repo root, with the Mac quiet (check `uptime`):

```bash
pnpm run build:main && pnpm --filter runpane build
export PANE_SCRATCH_DIR=<scratch folder>          # everything goes in $PANE_SCRATCH_DIR/perf.noindex
native/scripts/perf/hosts.sh up                   # two isolated hosts, each behind a 100 ms-each-way proxy
native/scripts/perf/hosts.sh seed                 # A: 68 Panes, 7 approvals, a 3,000-line terminal, a 200-message Session chat; B: 12 Panes
```

Pair the simulator with both hosts, using the codes in `perf.noindex/hostA.phone-code` and `hostB.phone-code` (they point at the proxies). Serve the app's JavaScript in production mode with timing stalls on, for example a dev client with `EXPO_PUBLIC_PANE_PERF=1 npx expo start --dev-client --no-dev --minify --port 8251`, then:

```bash
UDID=<simulator> LAUNCH_URL='exp+pane://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8251' \
  native/scripts/perf/journeys.sh <out-dir>           # or name scenarios: return-pane-terminal cold-launch …
node native/scripts/perf-table.mts <out-dir>/*.log
native/scripts/perf/hosts.sh down
```

Each scenario runs `RUNS` times (5); the table gives the median and the slowest run. A return stays away `AWAY_S` seconds (10) and changes something on the host meanwhile: a new Pane for Home, a chat message, terminal output. Record `uptime` with the numbers: a loaded Mac slows everything.

| Scenario | Targets |
|---|---|
| `return-session-chat`, `return-pane-terminal` | T1: `chat live`, `terminal live`, reads sent again, terminal handshakes |
| `return-home` | T2: `home fresh` |
| `cold-launch` | T3 to T6: `home frame`, `home fresh`, count changes, wrong counts shown |
| `open-terminal`, `reopen-terminal` | T7: first open from a fresh launch, and a revisit |
| `open-session-chat`, `reopen-session-chat` | T8 |
| `open-approval` | T9: layout final, layout changes (approval 2 of the seeded ones, then Next) |
| `switch` | T10: the machine pills, Perf-B then Perf-A |
| any, in a perf bundle | T12: stalls over 100 ms |

Every scenario starts from a fresh launch, and a reopen goes back with the screen's own back button, so earlier screens never stay mounted underneath. Navigation goes through Maestro, which answers iOS's "Open in Pane?" prompt; its accessibility snapshots can pause the app, so read stalls from the `return-*` and `cold-launch` scenarios.

A loopback host cannot stage a relay or a same-network address that stops answering; those paths are covered by unit tests and by a run on a phone.
