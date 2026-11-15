import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { SESSION_MOVE_CHANNELS, SESSION_MOVE_TARGET_CHANNELS } from '../../../shared/types/sessionMove';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { fixRequestSchema as coordinatorFixSchema, MoveCoordinator, moveRequestSchema, sessionRequestSchema, statusRequestSchema } from '../services/sessionMove/coordinator';
import { fixRequestSchema, MoveImporter, moveIdRequestSchema, preflightRequestSchema } from '../services/sessionMove/importer';
import { writeRequestSchema } from '../services/sessionMove/transfer';
import { testPeers } from '../services/sessionMove/peer';

/** The dialog's calls, on the Session's own host. */
const SOURCE_CHANNELS = Object.values(SESSION_MOVE_CHANNELS);

/**
 * Whole-Session moves (docs/SESSIONS.md, "Move a Session to another machine"): the source's
 * coordinator, which the dialog drives, and the target's importer, which the other Pane calls
 * over the Pane-to-Pane connection.
 */
export function registerSessionMoveHandlers(ipcMain: IpcMain, services: AppServices, commandRegistry: PaneCommandRegistry): void {
  const coordinator = new MoveCoordinator(services, commandRegistry);
  const importer = new MoveImporter(services, commandRegistry);
  const moveId = (request: PaneCommandValue) => decodeBoundary(request, moveIdRequestSchema).moveId;

  commandRegistry.register(SESSION_MOVE_CHANNELS.check, (request: PaneCommandValue) => coordinator.check(decodeBoundary(request, moveRequestSchema)));
  commandRegistry.register(SESSION_MOVE_CHANNELS.fix, (request: PaneCommandValue) => coordinator.fix(decodeBoundary(request, coordinatorFixSchema)));
  commandRegistry.register(SESSION_MOVE_CHANNELS.start, (request: PaneCommandValue) => coordinator.start(decodeBoundary(request, moveRequestSchema)));
  commandRegistry.register(SESSION_MOVE_CHANNELS.status, async (request: PaneCommandValue) => coordinator.status(decodeBoundary(request, statusRequestSchema)));
  commandRegistry.register(SESSION_MOVE_CHANNELS.stopNow, async (request: PaneCommandValue) => coordinator.stopNow(decodeBoundary(request, sessionRequestSchema)));
  commandRegistry.register(SESSION_MOVE_CHANNELS.cancel, (request: PaneCommandValue) => coordinator.cancel(decodeBoundary(request, sessionRequestSchema)));
  commandRegistry.register(SESSION_MOVE_CHANNELS.peers, async () => ({ peers: testPeers().map(peer => peer.name) }));

  commandRegistry.register(SESSION_MOVE_TARGET_CHANNELS.preflight, (request: PaneCommandValue) => importer.preflight(decodeBoundary(request, preflightRequestSchema).manifest));
  commandRegistry.register(SESSION_MOVE_TARGET_CHANNELS.fix, (request: PaneCommandValue) => importer.fix(decodeBoundary(request, fixRequestSchema).fix));
  commandRegistry.register(SESSION_MOVE_TARGET_CHANNELS.write, (request: PaneCommandValue) => importer.write(decodeBoundary(request, writeRequestSchema)));
  commandRegistry.register(SESSION_MOVE_TARGET_CHANNELS.build, async (request: PaneCommandValue) => importer.build(moveId(request)));
  commandRegistry.register(SESSION_MOVE_TARGET_CHANNELS.start, async (request: PaneCommandValue) => importer.start(moveId(request)));
  commandRegistry.register(SESSION_MOVE_TARGET_CHANNELS.abort, (request: PaneCommandValue) => importer.abort(moveId(request)));
  commandRegistry.register(SESSION_MOVE_TARGET_CHANNELS.status, async (request: PaneCommandValue) => importer.status(moveId(request)));

  commandRegistry.bindChannels(ipcMain, SOURCE_CHANNELS);
}
