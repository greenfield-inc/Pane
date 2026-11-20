import { SESSION_MOVE_CHANNELS, type SessionMoveFix, type SessionMovePreflight, type SessionMoveProgress } from '../../../shared/types/sessionMove';
import type { MachineCommand, MachineResult } from '../../../shared/types/machineConnections';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import { ipcErrorMessage } from './ipcErrorMessage';

/**
 * The calls Move to machine… makes, on the Session's own host: this window's host through
 * `invoke`, or a machine in All machines through `machines.run`'s `move-session` command.
 * Each channel takes one object argument (shared/types/sessionMove.ts).
 */
export type SessionMoveWhere = { kind: 'here' } | { kind: 'machine'; machineId: string };

type SessionMoveChannel = typeof SESSION_MOVE_CHANNELS[keyof typeof SESSION_MOVE_CHANNELS];

/** The one object argument each move channel takes (see SESSION_MOVE_CHANNELS). */
type SessionMoveRequest =
  | Record<string, never>
  | { sessionId: string; recheck?: true }
  | { sessionId: string; target: string; fix?: SessionMoveFix };

/** The `machines:run` command that carries a move call to the Session's machine. */
type MoveSessionCommand = { type: 'move-session'; channel: SessionMoveChannel; request: SessionMoveRequest };
type MachineRun = (machineId: string, command: MachineCommand | MoveSessionCommand) => Promise<MachineResult>;

const fixSchema: BoundarySchema<SessionMoveFix> = boundary.union(
  boundary.object({ kind: boundary.literal('clone'), label: boundary.string, remote: boundary.string, path: boundary.string }),
  boundary.object({ kind: boundary.literal('trust'), label: boundary.string, path: boundary.string }),
);

const preflightSchema: BoundarySchema<SessionMovePreflight> = boundary.object({
  target: boundary.nonEmptyString,
  ready: boundary.boolean,
  checks: boundary.array(boundary.object({
    id: boundary.string,
    level: boundary.enumeration('ok', 'warning', 'block'),
    title: boundary.string,
    detail: boundary.optional(boundary.string),
    fix: boundary.optional(fixSchema),
  })),
  paneCount: boundary.number,
  tabCount: boundary.number,
  bytes: boundary.number,
});

const progressSchema: BoundarySchema<SessionMoveProgress> = boundary.object({
  moveId: boundary.string,
  sessionId: boundary.string,
  sessionName: boundary.string,
  target: boundary.string,
  phase: boundary.enumeration('waiting', 'moving', 'confirming', 'done', 'failed', 'cancelled'),
  waiting: boundary.array(boundary.object({
    panelId: boundary.string,
    title: boundary.string,
    paneName: boundary.string,
    since: boundary.optional(boundary.string),
  })),
  stoppedTabs: boundary.number,
  totalTabs: boundary.number,
  steps: boundary.array(boundary.object({
    id: boundary.enumeration('stop', 'pack', 'send', 'build', 'start'),
    state: boundary.enumeration('pending', 'running', 'done', 'failed'),
    title: boundary.string,
    detail: boundary.optional(boundary.string),
  })),
  summary: boundary.optional(boundary.object({
    panes: boundary.number,
    tabs: boundary.number,
    resumed: boundary.number,
    failedTabs: boundary.array(boundary.string),
    approvals: boundary.number,
    leftBehind: boundary.array(boundary.string),
    missingEnv: boundary.array(boundary.string),
    previewsNotCarried: boundary.optional(boundary.array(boundary.string)),
    stayedHere: boundary.optional(boundary.array(boundary.string)),
  })),
  error: boundary.optional(boundary.object({ message: boundary.string, next: boundary.string })),
  frozen: boundary.boolean,
  waitReason: boundary.optional(boundary.enumeration('unreachable', 'undecided', 'startFailed')),
  updatedAt: boundary.string,
});

const peersSchema = boundary.object({ peers: boundary.array(boundary.nonEmptyString) });

/** A machine command's answer; a host that refused says `{ success: false }`. */
const refusedSchema = boundary.object({ success: boundary.literal(false), error: boundary.optional(boundary.string) });

async function call<Value>(where: SessionMoveWhere, channel: SessionMoveChannel, request: SessionMoveRequest, schema: BoundarySchema<Value>): Promise<Value> {
  let answer: unknown;
  try {
    if (where.kind === 'here') {
      answer = await window.electronAPI.invoke(channel, request);
    } else {
      // SAFETY: main's machines:run takes the move-session command; MachineCommand gains it in shared.
      const run = window.electronAPI.machines.run as MachineRun;
      answer = (await run(where.machineId, { type: 'move-session', channel, request })).data;
    }
  } catch (cause) {
    throw new Error(ipcErrorMessage(cause, 'The Session\'s machine did not answer.'));
  }
  const refused = decodeOptionalBoundary(answer, refusedSchema);
  if (refused) throw new Error(refused.error ?? 'The Session\'s machine refused it and did not say why.');
  return decodeBoundary(answer, schema);
}

/** Runs every check on `target`; stops nothing. */
export function checkSessionMove(where: SessionMoveWhere, sessionId: string, target: string): Promise<SessionMovePreflight> {
  return call(where, SESSION_MOVE_CHANNELS.check, { sessionId, target }, preflightSchema);
}

/** Runs one fix on `target`, then every check again. */
export function fixSessionMove(where: SessionMoveWhere, sessionId: string, target: string, fix: SessionMoveFix): Promise<SessionMovePreflight> {
  return call(where, SESSION_MOVE_CHANNELS.fix, { sessionId, target, fix }, preflightSchema);
}

export function startSessionMove(where: SessionMoveWhere, sessionId: string, target: string): Promise<SessionMoveProgress> {
  return call(where, SESSION_MOVE_CHANNELS.start, { sessionId, target }, progressSchema);
}

/** The move's progress, or null when the Session has no move. `recheck` asks a silent target again. */
export function sessionMoveStatus(where: SessionMoveWhere, sessionId: string, recheck = false): Promise<SessionMoveProgress | null> {
  return call(where, SESSION_MOVE_CHANNELS.status, recheck ? { sessionId, recheck: true } : { sessionId }, boundary.nullable(progressSchema));
}

export function stopSessionMoveNow(where: SessionMoveWhere, sessionId: string): Promise<SessionMoveProgress> {
  return call(where, SESSION_MOVE_CHANNELS.stopNow, { sessionId }, progressSchema);
}

export function cancelSessionMove(where: SessionMoveWhere, sessionId: string): Promise<SessionMoveProgress> {
  return call(where, SESSION_MOVE_CHANNELS.cancel, { sessionId }, progressSchema);
}

/** Loopback test machines the host offers as targets; none when the host has no such list. */
export async function sessionMovePeers(where: SessionMoveWhere): Promise<string[]> {
  try {
    return (await call(where, SESSION_MOVE_CHANNELS.peers, {}, peersSchema)).peers;
  } catch {
    return [];
  }
}
