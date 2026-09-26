import { boundary, decodeBoundary } from '../validation/boundaryDecoder';
import type { BoundarySchema, JsonValue } from '../validation/boundaryDecoder';
export type {
  PanePermissionInput,
  PanePermissionRequest,
  PanePermissionResponse,
  PanePermissionResolvedEvent,
} from './permissions';

export interface PaneDaemonRequestFrame {
  type: 'request';
  id: number;
  channel: string;
  args: JsonValue[];
}

export interface PaneDaemonSuccessResponseFrame {
  type: 'response';
  id: number;
  ok: true;
  result?: JsonValue;
}

export interface PaneDaemonError {
  message: string;
  code?: string;
}

export interface PaneDaemonErrorResponseFrame {
  type: 'response';
  id: number;
  ok: false;
  error: PaneDaemonError;
}

export interface PaneDaemonEventFrame {
  type: 'event';
  channel: string;
  args: JsonValue[];
}

export type PaneDaemonResponseFrame =
  | PaneDaemonSuccessResponseFrame
  | PaneDaemonErrorResponseFrame;

export type PaneDaemonFrame =
  | PaneDaemonRequestFrame
  | PaneDaemonResponseFrame
  | PaneDaemonEventFrame;

const requestFrameSchema: BoundarySchema<PaneDaemonRequestFrame> = boundary.object({
  type: boundary.literal('request'),
  id: boundary.number,
  channel: boundary.string,
  args: boundary.array(boundary.json),
});
const responseFrameSchema: BoundarySchema<PaneDaemonResponseFrame> = boundary.union(
  boundary.object({
    type: boundary.literal('response'),
    id: boundary.number,
    ok: boundary.literal(true),
    result: boundary.optional(boundary.json),
  }),
  boundary.object({
    type: boundary.literal('response'),
    id: boundary.number,
    ok: boundary.literal(false),
    error: boundary.object({
      message: boundary.string,
      code: boundary.optional(boundary.string),
    }),
  }),
);
const eventFrameSchema: BoundarySchema<PaneDaemonEventFrame> = boundary.object({
  type: boundary.literal('event'),
  channel: boundary.string,
  args: boundary.array(boundary.json),
});
const daemonFrameSchema: BoundarySchema<PaneDaemonFrame> = boundary.union(
  requestFrameSchema,
  responseFrameSchema,
  eventFrameSchema,
);

export const DAEMON_OWNED_CHANNEL_PREFIXES = [
  'agent-usage:',
  'folders:',
  'logs:',
  'mobile:',
  'panels:',
  'pane-chat:',
  'orchestration-sessions:',
  'projects:',
  'prompts:',
  'resource-monitor:',
  'runpane:',
  'sessions:',
  'terminal:',
  'usage:',
  'voice:',
] as const;

export const DAEMON_OWNED_EXACT_CHANNELS = [
  'git:cancel-status-for-project',
  'git:clone-repo',
  'git:commit',
  'git:execute-project',
  'git:file-status',
  'git:get-github-remote',
  'remote:pwa-affordances',
  'git:restore',
  'git:revert',
  'permission:getPending',
  'permission:respond',
  'file:copy',
  'file:delete',
  'file:duplicate',
  'file:exists',
  'file:getPath',
  'file:list',
  'file:move',
  'file:read',
  'file:read-binary',
  'file:read-project',
  'file:readAtRevision',
  'file:rename',
  'file:resolveAbsolutePath',
  'file:search',
  'file:write',
  'file:write-binary',
  'file:write-project',
] as const;

export const ELECTRON_ADAPTER_ONLY_CHANNELS = [
  'app:consume-unclean-shutdown',
  'file:showInFolder',
  'sessions:open-ide',
  'terminal:clipboard-paste-image',
] as const;

const ELECTRON_ADAPTER_ONLY_CHANNEL_SET = new Set<string>(ELECTRON_ADAPTER_ONLY_CHANNELS);

export function isDaemonOwnedChannel(channel: string): boolean {
  if (ELECTRON_ADAPTER_ONLY_CHANNEL_SET.has(channel)) {
    return false;
  }

  if (DAEMON_OWNED_EXACT_CHANNELS.some((ownedChannel) => ownedChannel === channel)) {
    return true;
  }

  return DAEMON_OWNED_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

export function isPaneDaemonRequestFrame(frame: JsonValue): boolean {
  return matchesSchema(frame, requestFrameSchema);
}

export function isPaneDaemonResponseFrame(frame: JsonValue): boolean {
  return matchesSchema(frame, responseFrameSchema);
}

export function isPaneDaemonEventFrame(frame: JsonValue): boolean {
  return matchesSchema(frame, eventFrameSchema);
}

export function isPaneDaemonFrame(frame: JsonValue): boolean {
  return matchesSchema(frame, daemonFrameSchema);
}

export function parsePaneDaemonFrame(frame: JsonValue): PaneDaemonFrame {
  return decodeBoundary(frame, daemonFrameSchema);
}

function matchesSchema<Value>(frame: JsonValue, schema: BoundarySchema<Value>): boolean {
  try {
    decodeBoundary(frame, schema);
    return true;
  } catch {
    return false;
  }
}
