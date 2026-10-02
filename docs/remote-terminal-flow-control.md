# Remote terminal output flow control

Terminal panels begin hidden until a client registers visibility with
`terminal:setVisibility`. Hidden panels still stream to daemon subscribers and
retain scrollback, but do not wait for renderer acknowledgements. A raw SSE
subscriber does not register visibility by merely opening `/events`.

Visible panels pause their PTY at 100,000 unacknowledged characters and resume
at 5,000. The five-second safety timeout abandons the stale acknowledgement
count before resuming; fresh output can still cross the high watermark and
pause again. This escape hatch prevents one lost acknowledgement from causing
every subsequent flush to wait five seconds. It does not disable backpressure
for a visible client that consistently fails to acknowledge output.

Acknowledgements have no sequence or generation. After timeout recovery, a
delayed acknowledgement can temporarily reduce the fresh backlog count. Keeping
forgiven debt would instead discard valid new acknowledgements when the old ones
were lost. Strict accounting across recovery would require a protocol change.

Desktop clients connected to a remote host acknowledge processed output through
`terminal:ack`, including when a PTY ID is known. Only local terminals can use
the local PTY host MessagePort. Clients attached to an already-running panel
can acknowledge by panel ID without receiving a new `terminal:ptyReady` event.

Acknowledgement accounting is per terminal, not per viewer: one responsive
viewer can release a pause even if another viewer is silent. Removing the last
viewer clears pending flow control and resumes the PTY. Registered viewers
survive a PTY host respawn, and attach/detach changes during an asynchronous spawn
are applied to the replacement terminal.

Focused regression checks:

```sh
pnpm --filter main test run src/ptyHost/flowControl.test.ts src/services/terminalPanelManager.persistence.test.ts src/services/terminalPanelManager.test.ts
pnpm --filter frontend test src/utils/terminalAck.test.ts
```
