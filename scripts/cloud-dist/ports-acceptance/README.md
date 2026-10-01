# Session ports acceptance (Phase 5)

An independent acceptance run for Session ports on a **released** build. It drives only the released
`runpane` CLI, the Session's own `runpane port`, Tailscale, and plain HTTPS from a tailnet device. It
doesn't use the ports implementation's tests or fakes.

| Step | What it proves |
|---|---|
| `new` + `c1` | **Default path:** a fresh Session made with `cloud new --repo <repo with .runpane/ports.json>` publishes the declared ports at boot. `cloud port list --json` shows https URLs, and each URL answers 200 from a tailnet device with a CA-verified Let's Encrypt cert for the Session's name. |
| `c2` | **Clash:** the same service port on two Sessions at once gives two URLs, and each answers with its own box's body (the body names the Session, its tailnet name and its boot id). Several ports on one Session; the other ports keep answering. |
| `c3-restart` | **Daemon restart:** ports keep answering. Then Serve entries are dropped and the daemon restarted: the boot reconcile re-applies them (time to 200 recorded). |
| `c3-wake` | **Stop/wake** via the CLI: URLs are dead while asleep and come back by themselves after wake. Time to 200 is measured from the wake command's start; the changed boot id proves a real reboot. |
| `c4` | **Suggested:** a listener started under a Pane panel (`agents start --tool-command`) is suggested, not published, and unreachable until `port open`. A listener outside any panel isn't suggested. |
| `c5` | **Refusals:** :443 and the daemon's port are refused (as the service port and as the tailnet port), as is a duplicate tailnet port. A privileged tailnet port and a foreign local service are recorded as observed. The nft ruleset is unchanged, closing leaves Serve as it was, and there's no Funnel. |
| `c6` | The taste app's walk (Chromium + WebKit, 13 checks each) on Scratch's managed :8443/:8444, and `port list` shows them as managed ports. |

Each step writes raw evidence plus `verdicts.txt` lines (`PASS`/`FAIL` per assertion, from `judge.py`)
into `$EV`. For the environment it needs, see `acceptance.sh`'s header. `session/*.sh` run inside a
Session through `$PV_EXEC <sandbox id> <script>` (a runner that uploads a script and executes it).

Cost: one boat start for `new`, one for `c3-wake`, and one Let's Encrypt certificate for the new host
name. The tailnet shares 50 certs per week, refilling one every 202 min, so check `tailscale cert` or
the CT log before creating a Session.
