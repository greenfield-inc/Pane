# Devices

Any agent in a Pane can boot an iOS Simulator or an Android emulator, see it, drive it and
build an app to it. The live screen opens in a device tab beside the agent, and chat tabs
show a card at the step that opened it. On Windows and Linux, iOS runs on a Mac you linked,
with no SSH setup.

## The tools

Every agent gets six device tools through Pane's MCP server, and every terminal has the same
commands as `runpane devices`. Pane fills in the Pane, the device and the machine: after
`device_open`, an agent never names them again.

| Tool | Command | What it does |
| --- | --- | --- |
| `device_list` | `runpane devices list` | Devices this Pane can open: platform, name, OS, machine, state, and which Pane holds each |
| `device_open` | `runpane devices open --platform ios` | Leases a device to this Pane, boots it and opens the device tab |
| `device_screenshot` | `runpane devices screenshot` | The screen as an image (MCP) or a PNG path (CLI) |
| `device_act` | `runpane devices act -- snapshot -i` | Runs an [agent-device](https://github.com/callstack/agent-device) command on the device |
| `device_run` | `runpane devices run -- npx expo run:ios` | Runs a command where the device runs, such as a build, or Metro with `--background` |
| `device_close` | `runpane devices close` | Ends the lease and stops the commands `device_run` started |

A typical session:

```sh
runpane devices open --platform ios --json
runpane devices run --json -- npx expo run:ios
runpane devices act --json -- open com.example.app
runpane devices act --json -- snapshot -i          # the screen's elements as @refs
runpane devices act --json -- press @e3 --settle
runpane devices screenshot --json
runpane devices close --json
```

`device_act` passes any agent-device command through (`help workflow` lists them), pinned to
the device this Pane holds. Flags that would pick another device, session or daemon
(`--session`, `--device`, `--udid`, `--serial`, `--platform`) are refused.

## Setup

Nothing to install up front. On the first device call, Pane installs two pinned open-source
helpers with npm into its data folder (about a minute): Callstack's agent-device, which drives
devices for agents, and Expo's device hub, which boots devices and streams their screen. They
run on Pane's own Node, so your Node version doesn't matter, but npm must be on the PATH once.

| Platform | Needs |
| --- | --- |
| iOS | A Mac with Xcode and an iOS runtime (Xcode > Settings > Components) |
| Android | The Android SDK with its emulator and platform-tools (Android Studio), and a system image. To let Pane make its own emulator, also install "Android SDK Command-line Tools (latest)" |
| Android on Linux | KVM (`/dev/kvm`) |

Pane never installs Xcode, the Android SDK, runtimes or system images; when one is missing,
the tool's error says what and where to get it. **Settings → Devices** shows what this
computer has.

## iOS from Windows and Linux

A computer without Xcode runs iOS on a linked Mac. Link one once: on the Mac, open
**Add a device → Computer** and choose **Copy link**; on this computer, open
**Add a device → Computer** and paste it under **Or finish here** (or run
`runpane link '<link>'`).

`device_open` then uses the Mac pinned in **Settings → Devices → iOS devices run on**, or
else the first online Mac with Xcode, and its result says which Mac and why. A pinned Mac is
always used: when it is offline the call fails with `ERR_DEVICE_MAC_OFFLINE` and doesn't
fall back. Every call goes over the routes saved computers already use (same network,
Tailscale or the Pane relay); the Mac accepts device calls only from your linked computers.

`device_run` builds on the Mac without a clone or credentials there: it snapshots the
worktree (uncommitted and untracked files included, ignored files left out), sends what
changed since the last run as a git bundle to a Pane checkout on the Mac, and runs the
command in that checkout. Ignored build products such as `node_modules` and `Pods` stay
there between runs. Metro started with `--background` keeps running on the Mac until
`device_close`, and serves the simulator on the Mac's own localhost. Archiving the Pane stops
its jobs on the Mac and removes its checkout there.

| Error | Means |
| --- | --- |
| `ERR_DEVICE_NO_MAC` | No Mac is linked. Link one, as above. Android works on this computer meanwhile |
| `ERR_DEVICE_MAC_OFFLINE` | The Mac is asleep or Pane isn't running there. Wake it, or pick another Mac in Settings |
| `ERR_DEVICE_MAC_OUTDATED` | The Mac's Pane predates devices. Update it |

## Sharing and resources

Booted simulators are heavy, so Pane keeps few of them:

- **A small pool per machine.** Pane makes its own devices (`Pane iPhone` on the newest iOS
  runtime you installed, `Pane_Android`) and reuses them; it makes another only when none
  fits. It uses one of your own devices only when an agent names it with `--device`.
- **One booted device per platform** by default, shared between Panes by lease.
  **Settings → Devices → Simulators at once** raises it to four.
- **Leases.** A Pane holds its device until `device_close`, archive, or 10 minutes with no
  device call and its tab on screen nowhere. When every device is held, `device_open` waits up
  to 60 seconds, then fails with `ERR_DEVICE_BUSY` naming the holder; **Take over** in the
  device tab moves the lease. When a device passes to another Pane, Pane uninstalls the apps
  the last Pane installed, without a reboot.
- **Idle shutdown.** A lease that idles out shuts the device down at once; after
  `device_close` it stays warm for 10 minutes. The helpers stop when nothing is booted.
- **Erase and delete.** Archiving the last Pane that used one of Pane's devices erases it;
  Pane's devices unused for 7 days are deleted. Pane never deletes your devices or runtimes.
- **SimSlim.** With [simslim](https://github.com/MobAI-App/simslim) installed
  (`brew install mobai-app/tap/simslim`), Pane slims each of its iOS devices once, which cuts a
  booted simulator from about 4 GB to under 1 GB.

`runpane devices usage --json` lists every simulator and emulator on the machine (including
ones made outside Pane, `paneMade: false`) with its OS, disk and, when booted, memory, plus the
helpers' memory and the build checkouts. `runpane devices free --idle --yes` shuts down
unused Pane devices; `--all` also deletes them.

## Phones and the browser app

The device tab shows on the phone apps and in the browser app as frames, about two a second,
with tap and Home. The live stream stays on the desktop. Chat tabs on the desktop and in the
browser app show the device card; the native app shows an **Open** row.

## Security

The device hub listens on loopback only and requires a token, which stays in Pane's main
process: it never reaches a tab, a log, a tool result or an agent. Device tools act only on
the calling tab's Pane, and refuse calls from outside a Pane tab. **Settings → Devices →
Agent device tools** turns the tools off.
