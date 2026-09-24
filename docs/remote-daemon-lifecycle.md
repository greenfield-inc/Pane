# Remote Daemon Lifecycle

This is the implementation checklist for Remote Pane setup, teardown, and runtime switching. It exists to keep config writes, runtime controller actions, and renderer refreshes in sync.

## Runtime Roles

- Host lifecycle is owned by `PaneRemoteTransportController` and `remoteHostRuntimeStateStore`.
- Client lifecycle is owned by `RemotePaneClientController`.
- IPC handlers in `main/src/ipc/remoteDaemon.ts` orchestrate config writes and controller calls.
- Renderer runtime changes are reconciled through `remote-daemon:resync-required`.

## Lifecycle Matrix

| Action | Main-process side effect | Renderer side effect |
| --- | --- | --- |
| Import connection and connect succeeds | Activate profile, save/dedupe profile, set remote mode | Resync config, sessions, panels |
| Import connection and connect fails | Save/dedupe profile, keep current active runtime | No runtime resync |
| Connect saved profile | Activate profile before persisting remote mode | Resync config, sessions, panels |
| Switch to local runtime | Disconnect active remote client, save local mode | Resync config, sessions, panels, clear stale active session |
| Delete inactive profile | Remove profile | No runtime resync |
| Delete active profile | Switch local, remove profile, save local mode | Resync config, sessions, panels |
| Enable or update host | Save host config, transport controller syncs to live or error | Host-state event updates UI |
| Stop host | Save disabled host config, transport controller stops server | Host-state event updates UI |
| Disconnect host clients | Drop matching SSE clients | Host-state event updates client count |
| Revoke host client | Remove saved client record, drop matching SSE clients | Host-state event updates client count |

## Guardrails

- Do not persist remote mode until the selected profile has successfully activated.
- Failed import-connect saves the profile but must not switch runtime or emit a renderer resync.
- Connected remote clients are runtime state, not saved client records.
- Current Pane Data hosting is live only while that Pane app is running.
- Isolated daemon data can install a background service; Current Pane Data should not.

## Terminal Input

Desktop and browser clients send at most one terminal input request per panel at a time. Keys typed while a request is pending are combined into the next request, preserving their order without a separate round trip for every buffered key. A bare Escape always ends a combined request, because terminal apps read Escape followed by another key in the same write as an Alt shortcut. Different panels and other remote commands remain independent.

Input requests are not retried. On failure, disconnect, or a ten-second input timeout, queued input is discarded and outstanding callers are rejected. An interrupted request may already have reached the host, so its input must not be replayed after reconnecting. This uses the existing HTTP API and requires no host protocol upgrade.
