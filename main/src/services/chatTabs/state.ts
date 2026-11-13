import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import type { ToolPanelState } from '../../../../shared/types/panels';

const image = boundary.object({ mimeType: boundary.string, data: boundary.string });
const report = boundary.object({
  state: boundary.enumeration('ready', 'blocked', 'failed', 'done'),
  pr: boundary.optional(boundary.number), head: boundary.optional(boundary.string), summary: boundary.optional(boundary.string),
  summaryTruncated: boundary.optional(boundary.literal(true)), summaryPath: boundary.optional(boundary.string), question: boundary.optional(boundary.string),
  reportedAt: boundary.string,
});
const schema: BoundarySchema<ChatPanelState> = boundary.object({
  agent: boundary.nonEmptyString,
  launch: boundary.union(
    boundary.object({ kind: boundary.literal('agent'), mode: boundary.optional(boundary.string), fullAccess: boundary.optional(boundary.literal(true)) }),
    boundary.object({ kind: boundary.literal('profile'), profile: boundary.nonEmptyString, args: boundary.optional(boundary.record(boundary.string)) }),
  ),
  cwd: boundary.string,
  acpSessionId: boundary.optional(boundary.string),
  status: boundary.enumeration('starting', 'idle', 'working', 'blocked', 'stopped'),
  problem: boundary.optional(boundary.object({
    code: boundary.enumeration('signed-out', 'not-installed', 'adapter-setup', 'exited', 'failed', 'unsupported-host'),
    message: boundary.string, next: boundary.string,
    action: boundary.optional(boundary.enumeration('sign-in', 'install', 'restart')), url: boundary.optional(boundary.string),
  })),
  turn: boundary.optional(boundary.object({ operationId: boundary.string, startedAt: boundary.string })),
  settings: boundary.optional(boundary.record(boundary.string)),
  receipts: boundary.optional(boundary.array(boundary.object({
    operationId: boundary.string, generation: boundary.number, fingerprint: boundary.string,
    state: boundary.enumeration('accepted', 'completed', 'failed'), error: boundary.optional(boundary.string),
  }))),
  queue: boundary.optional(boundary.array(boundary.object({ operationId: boundary.string, text: boundary.string, images: boundary.optional(boundary.array(image)), queuedAt: boundary.string, stored: boundary.optional(boundary.literal(true)), imageCount: boundary.optional(boundary.number) }))),
  initialInput: boundary.optional(boundary.string),
  initialInputSentAt: boundary.optional(boundary.string),
  orchestrationSessionId: boundary.optional(boundary.string),
  sessionFolder: boundary.optional(boundary.string),
  autopilotRunId: boundary.optional(boundary.string),
  agentReport: boundary.optional(report),
  clearedAt: boundary.optional(boundary.string),
  notice: boundary.optional(boundary.string),
  open: boundary.optional(boundary.literal('most-recent')),
  banner: boundary.optional(boundary.union(
    boundary.object({ kind: boundary.enumeration('most-recent', 'none', 'known-empty') }),
    boundary.object({ kind: boundary.literal('list-failed'), reason: boundary.string }),
  )),
  paused: boundary.optional(boundary.object({
    at: boundary.string, by: boundary.enumeration('manual', 'auto'),
    idleHours: boundary.optional(boundary.number), runScript: boundary.optional(boundary.boolean),
  })),
  turnTimes: boundary.optional(boundary.object({
    sessionId: boundary.string,
    turns: boundary.array(boundary.object({ after: boundary.string, stopReason: boundary.string, startedAt: boundary.string, endedAt: boundary.string })),
  })),
});

/** A chat panel's saved state, or undefined when the row does not hold one. */
export function decodeChatPanelState(value: ToolPanelState['customState']): ChatPanelState | undefined {
  return decodeOptionalBoundary(value, schema);
}
