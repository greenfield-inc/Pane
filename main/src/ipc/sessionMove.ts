import type { IpcMain } from 'electron';
import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { SESSION_MOVE_CHANNELS, SESSION_MOVE_TARGET_CHANNELS } from '../../../shared/types/sessionMove';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { fixRequestSchema as coordinatorFixSchema, MoveCoordinator, moveRequestSchema, sessionRequestSchema, statusRequestSchema } from '../services/sessionMove/coordinator';
import { fixRequestSchema, MoveImporter, moveIdRequestSchema, preflightRequestSchema, refuseTeammateMove } from '../services/sessionMove/importer';
import { writeRequestSchema } from '../services/sessionMove/transfer';
import { testPeers } from '../services/sessionMove/peer';
import { paneCloudForMoves } from './paneCloud';

/** How long after Pane starts an interrupted move resumes. */
const RESUME_AFTER_START_MS = 10_000;

/** The dialog's calls, on the Session's own host. */
const SOURCE_CHANNELS = Object.values(SESSION_MOVE_CHANNELS);

/**
 * Whole-Session moves (docs/SESSIONS.md, "Move a Session to another machine"): the source's
 * coordinator, which the dialog drives, and the target's importer, which the other Pane calls
 * over the Pane-to-Pane connection.
 */
export function registerSessionMoveHandlers(ipcMain: IpcMain, services: AppServices, commandRegistry: PaneCommandRegistry): void {
  const coordinator = new MoveCoordinator(services, commandRegistry, () => paneCloudForMoves());
  const importer = new MoveImporter(services, commandRegistry);
  const moveId = (request: PaneCommandValue) => decodeBoundary(request, moveIdRequestSchema).moveId;

  // Every move call, source and target, answers only the owner's own machines (never a teammate on a shared tailnet).
  const register = (channel: string, handler: (request: PaneCommandValue) => PaneCommandValue | Promise<PaneCommandValue>) =>
    commandRegistry.register(channel, (request: PaneCommandValue) => { refuseTeammateMove(); return handler(request); });

  register(SESSION_MOVE_CHANNELS.check, (request: PaneCommandValue) => coordinator.check(decodeBoundary(request, moveRequestSchema)));
  register(SESSION_MOVE_CHANNELS.fix, (request: PaneCommandValue) => coordinator.fix(decodeBoundary(request, coordinatorFixSchema)));
  register(SESSION_MOVE_CHANNELS.start, (request: PaneCommandValue) => coordinator.start(decodeBoundary(request, moveRequestSchema)));
  register(SESSION_MOVE_CHANNELS.status, async (request: PaneCommandValue) => coordinator.status(decodeBoundary(request, statusRequestSchema)));
  register(SESSION_MOVE_CHANNELS.stopNow, async (request: PaneCommandValue) => coordinator.stopNow(decodeBoundary(request, sessionRequestSchema)));
  register(SESSION_MOVE_CHANNELS.cancel, (request: PaneCommandValue) => coordinator.cancel(decodeBoundary(request, sessionRequestSchema)));
  register(SESSION_MOVE_CHANNELS.peers, async () => ({ peers: testPeers().map(peer => peer.name) }));

  // Over the tailnet the source's calls arrive here as remote commands. A loopback test peer's come
  // over the local socket instead, so a dev build that has test peers runs them as remote too, and a
  // move between two dev instances meets the same checks a real one does (T-42).
  const remoteInTests = testPeers().length > 0;
  const target = (channel: string, handler: (request: PaneCommandValue) => PaneCommandValue | Promise<PaneCommandValue>) =>
    register(channel, (request: PaneCommandValue) => remoteInTests && !isRemotePaneCommand()
      ? commandRegistry.invokeRemote(channel, [request])
      : handler(request));

  target(SESSION_MOVE_TARGET_CHANNELS.preflight, (request: PaneCommandValue) => importer.preflight(decodeBoundary(request, preflightRequestSchema).manifest));
  target(SESSION_MOVE_TARGET_CHANNELS.fix, (request: PaneCommandValue) => importer.fix(decodeBoundary(request, fixRequestSchema).fix));
  target(SESSION_MOVE_TARGET_CHANNELS.write, (request: PaneCommandValue) => importer.write(decodeBoundary(request, writeRequestSchema)));
  target(SESSION_MOVE_TARGET_CHANNELS.build, async (request: PaneCommandValue) => importer.build(moveId(request)));
  target(SESSION_MOVE_TARGET_CHANNELS.start, async (request: PaneCommandValue) => importer.start(moveId(request)));
  target(SESSION_MOVE_TARGET_CHANNELS.abort, (request: PaneCommandValue) => importer.abort(moveId(request)));
  target(SESSION_MOVE_TARGET_CHANNELS.status, async (request: PaneCommandValue) => importer.status(moveId(request)));

  commandRegistry.bindChannels(ipcMain, SOURCE_CHANNELS);

  // A move this Pane was in the middle of when it quit carries on to its outcome: the target
  // finishes a start it had committed, and the source asks the target again about a frozen
  // Session. Deferred so the tab managers and the Pane-to-Pane connection are up first.
  setTimeout(() => {
    void importer.resume().catch(error => console.error('[SessionMove] Moves arriving here didn\'t resume:', error));
    void coordinator.resume().catch(error => console.error('[SessionMove] Moves from here didn\'t resume:', error));
  }, RESUME_AFTER_START_MS).unref();
}
