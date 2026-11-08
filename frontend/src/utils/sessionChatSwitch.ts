import type { SessionChatSwitchItem, SessionChatSwitchOutcome, SessionChatSwitchPreview, SessionChatSwitchResult, SessionChatSwitchSkip } from '../../../shared/types/chatTab';
import type { MachineCommand } from '../../../shared/types/machineConnections';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';

/** Where a Session lives: the host this window shows, or a machine on All machines. */
export type SessionSwitchWhere = { kind: 'here' } | { kind: 'machine'; machineId: string };

const SKIP_LABELS = {
  busy: 'busy',
  'plain-codex': 'plain Codex',
  'no-conversation': 'no saved conversation',
  launch: 'launch chat can\'t run',
  'not-agent': 'not an agent',
  other: 'can\'t switch',
} satisfies Record<SessionChatSwitchSkip, string>;

export function skipLabel(kind: SessionChatSwitchSkip): string { return SKIP_LABELS[kind]; }

const skipSchema = boundary.object({
  kind: boundary.enumeration('busy', 'plain-codex', 'no-conversation', 'launch', 'not-agent', 'other'),
  reason: boundary.string,
});
const itemFields = { panelId: boundary.nonEmptyString, title: boundary.string, paneName: boundary.string, skip: boundary.optional(skipSchema) };
const previewSchema = boundary.object({ sessionId: boundary.nonEmptyString, items: boundary.array(boundary.object(itemFields)) });
const resultSchema = boundary.object({
  sessionId: boundary.nonEmptyString,
  items: boundary.array(boundary.object({ ...itemFields, result: boundary.enumeration('switched', 'skipped', 'failed'), note: boundary.optional(boundary.string) })),
});

/** A machine command's answer; a host that refused says `{ success: false }`. */
const refusedSchema = boundary.object({ success: boundary.literal(false), error: boundary.optional(boundary.string) });

async function onMachine<Value>(machineId: string, command: MachineCommand, schema: BoundarySchema<Value>): Promise<Value> {
  const { data } = await window.electronAPI.machines.run(machineId, command);
  const refused = decodeOptionalBoundary(data, refusedSchema);
  if (refused) throw new Error(refused.error ?? 'The machine refused it and did not say why.');
  return decodeBoundary(data, schema);
}

export async function previewSessionChatSwitch(where: SessionSwitchWhere, sessionId: string): Promise<SessionChatSwitchPreview> {
  return where.kind === 'here'
    ? decodeBoundary(await window.electronAPI.chatTab.previewSessionSwitch(sessionId), previewSchema)
    : onMachine(where.machineId, { type: 'preview-switch-to-chat', sessionId }, previewSchema);
}

export async function runSessionChatSwitch(where: SessionSwitchWhere, sessionId: string, panelIds: string[]): Promise<SessionChatSwitchResult> {
  return where.kind === 'here'
    ? decodeBoundary(await window.electronAPI.chatTab.switchSession(sessionId, panelIds), resultSchema)
    : onMachine(where.machineId, { type: 'switch-to-chat', sessionId, panelIds }, resultSchema);
}

export function switchable(items: readonly SessionChatSwitchItem[]): SessionChatSwitchItem[] {
  return items.filter(item => !item.skip);
}

/** "4 switched, 1 skipped: busy": each skip kind once, in the order it first appears. */
export function summarizeSessionSwitch(items: readonly SessionChatSwitchOutcome[]): string {
  const skipped = items.filter(item => item.result === 'skipped');
  const failed = items.filter(item => item.result === 'failed').length;
  const parts = [`${items.filter(item => item.result === 'switched').length} switched`];
  if (skipped.length) {
    const kinds = [...new Set(skipped.map(item => skipLabel(item.skip?.kind ?? 'other')))];
    parts.push(`${skipped.length} skipped: ${kinds.join(', ')}`);
  }
  if (failed) parts.push(`${failed} failed`);
  return parts.join(', ');
}
