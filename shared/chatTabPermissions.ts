import { boundary, decodeOptionalBoundary } from './validation/boundaryDecoder';
import type { AgentChatPermission } from './types/agentChat';

export interface PermissionSummary {
  kind: 'command' | 'edit' | 'plan' | 'other';
  /** "Claude wants to run a command". */
  heading: string;
  /** The command, file or tool input, shown as code. */
  detail?: string;
  /** ExitPlanMode's plan, as markdown. */
  plan?: string;
}

const toolCall = boundary.object({
  title: boundary.optional(boundary.nullable(boundary.string)),
  kind: boundary.optional(boundary.nullable(boundary.string)),
  rawInput: boundary.optional(boundary.json),
  locations: boundary.optional(boundary.nullable(boundary.array(boundary.object({ path: boundary.string })))),
});
const input = boundary.object({
  command: boundary.optional(boundary.union(boundary.string, boundary.array(boundary.string))),
  file_path: boundary.optional(boundary.string),
  path: boundary.optional(boundary.string),
  plan: boundary.optional(boundary.string),
});

/** What an approval asks, in words, from the tool call the adapter sent. */
export function permissionSummary(permission: AgentChatPermission, agent: string): PermissionSummary {
  const call = decodeOptionalBoundary(permission.toolCall, toolCall);
  const raw = decodeOptionalBoundary(call?.rawInput, input);
  if (raw?.plan) return { kind: 'plan', heading: `${agent}'s plan is ready`, plan: raw.plan };
  if (call?.kind === 'execute' || raw?.command) {
    return { kind: 'command', heading: `${agent} wants to run a command`, detail: Array.isArray(raw?.command) ? raw.command.join(' ') : raw?.command ?? call?.title ?? permission.title };
  }
  const file = raw?.file_path ?? raw?.path ?? call?.locations?.[0]?.path;
  if (call?.kind === 'edit' || call?.kind === 'delete' || call?.kind === 'move') return { kind: 'edit', heading: `${agent} wants to change a file`, detail: file ?? call?.title ?? permission.title };
  return { kind: 'other', heading: call?.title ?? permission.title ?? `${agent} needs your approval`, detail: call?.rawInput !== undefined ? JSON.stringify(call.rawInput, null, 2) : undefined };
}

/** The option that declines this request, used when the person types an instruction instead. */
export function rejectOption(permission: AgentChatPermission): string | undefined {
  return (permission.options.find(option => option.kind === 'reject_once') ?? permission.options.find(option => option.kind.startsWith('reject')))?.optionId;
}
