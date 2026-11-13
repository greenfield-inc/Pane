import type { SessionChatSwitchItem, SessionChatSwitchOutcome, SessionChatSwitchPreview, SessionChatSwitchResult, SessionChatSwitchSkip } from '../../../shared/types/chatTab';
import type { MachineCommand } from '../../../shared/types/machineConnections';
import { useConfigStore } from '../stores/configStore';
import { useErrorStore } from '../stores/errorStore';
import { ipcErrorMessage } from './ipcErrorMessage';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';

/** Where a Session lives: the host this window shows, or a machine on All machines. */
export type SessionSwitchWhere = { kind: 'here' } | { kind: 'machine'; machineId: string };

const SKIP_LABELS = {
  busy: 'busy',
  'no-conversation': 'no saved conversation',
  launch: 'launch chat can\'t run',
  'not-agent': 'not an agent',
  unconfirmed: 'not confirmed',
  other: 'can\'t switch',
} satisfies Record<SessionChatSwitchSkip, string>;

export function skipLabel(kind: SessionChatSwitchSkip): string { return SKIP_LABELS[kind]; }

const skipSchema = boundary.object({
  kind: boundary.enumeration('busy', 'no-conversation', 'launch', 'not-agent', 'unconfirmed', 'other'),
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

export interface OutcomesByResult { switched: SessionChatSwitchOutcome[]; failed: SessionChatSwitchOutcome[]; skipped: SessionChatSwitchOutcome[] }

/** The outcomes sorted by what happened to each tab, in one pass and in Session order. */
export function byResult(items: readonly SessionChatSwitchOutcome[]): OutcomesByResult {
  const groups: OutcomesByResult = { switched: [], failed: [], skipped: [] };
  for (const item of items) groups[item.result].push(item);
  return groups;
}

/** "4 switched, 1 skipped: busy": each skip kind once, in the order it first appears. */
export function summarizeSessionSwitch(items: readonly SessionChatSwitchOutcome[]): string {
  const { switched, failed, skipped } = byResult(items);
  const parts = [`${switched.length} switched`];
  if (skipped.length) {
    const kinds = [...new Set(skipped.map(item => skipLabel(item.skip?.kind ?? 'other')))];
    parts.push(`${skipped.length} skipped: ${kinds.join(', ')}`);
  }
  if (failed.length) parts.push(`${failed.length} failed`);
  return parts.join(', ');
}

export type SessionSwitchMenuState =
  | { state: 'checking' }
  | { state: 'ready'; preview: SessionChatSwitchPreview }
  /** `turnOn` when chat tabs are off on the host this window shows, which can turn them on. */
  | { state: 'unavailable'; reason: string; turnOn?: boolean };

/** Main's refusal when chat tabs are off on the machine that ran the preview (`prepareSwitch`). */
const CHAT_TABS_OFF = /^Chat tabs are turned off/;

/**
 * What the menu says about a preview: ready when some tab can switch, else why nothing can,
 * counted by reason ("Nothing to switch: 2 busy, 1 plain Codex"). Plain shells are not counted.
 */
export function switchMenuState(preview: SessionChatSwitchPreview, machineName: string): SessionSwitchMenuState {
  if (switchable(preview.items).length > 0) return { state: 'ready', preview };
  const skips = preview.items.flatMap(item => (item.skip && item.skip.kind !== 'not-agent' ? [item.skip] : []));
  if (skips.some(skip => skip.kind === 'other' && CHAT_TABS_OFF.test(skip.reason))) {
    return { state: 'unavailable', reason: `Chat tabs are off on ${machineName}` };
  }
  if (skips.length === 0) return { state: 'unavailable', reason: 'No terminal agent tabs to switch' };
  const counts = new Map<string, number>();
  for (const skip of skips) counts.set(skipLabel(skip.kind), (counts.get(skipLabel(skip.kind)) ?? 0) + 1);
  return { state: 'unavailable', reason: `Nothing to switch: ${[...counts].map(([label, count]) => `${count} ${label}`).join(', ')}` };
}

/** Turns chat tabs on for the host this window shows. */
export async function turnOnChatTabsHere(): Promise<void> {
  try {
    await useConfigStore.getState().updateConfig({ chatTabsEnabled: true });
  } catch (error) {
    useErrorStore.getState().showError({ title: 'Chat tabs are still off', error: `${ipcErrorMessage(error, 'The setting was not saved.').replace(/[^.!?]$/, '$&.')} Turn them on in Settings > Advanced > Experimental.` });
  }
}
