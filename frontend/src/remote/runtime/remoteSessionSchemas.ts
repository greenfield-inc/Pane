import { boundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import type { ClaudeJsonMessage, Session } from '../../types/session';

const optionalString = boundary.optional(boundary.string);
const optionalNumber = boundary.optional(boundary.number);
const optionalBoolean = boundary.optional(boundary.boolean);
const messageContent = boundary.union(boundary.string, boundary.array(boundary.union(
  boundary.object({ type: boundary.literal('text'), text: boundary.string }),
  boundary.object({ type: boundary.literal('tool_use'), id: boundary.string, name: boundary.string, input: boundary.jsonObject }),
  boundary.object({ type: boundary.literal('tool_result'), tool_use_id: boundary.string, content: boundary.string, is_error: optionalBoolean }),
)));
const remoteMessageSchema: BoundarySchema<ClaudeJsonMessage> = boundary.object({
  id: optionalString, type: boundary.enumeration('user', 'assistant', 'system', 'tool_use', 'tool_result', 'result', 'thinking'),
  role: boundary.optional(boundary.enumeration('user', 'assistant', 'system')),
  content: boundary.optional(messageContent), message: boundary.optional(boundary.object({ content: boundary.optional(messageContent) })),
  timestamp: boundary.string, name: optionalString, input: boundary.optional(boundary.jsonObject), tool_use_id: optionalString,
  parent_tool_use_id: optionalString, session_id: optionalString, text: optionalString, subtype: optionalString,
  cwd: optionalString, model: optionalString, permissionMode: optionalString, summary: optionalString, error: optionalString,
  details: optionalString, raw_output: optionalString, is_error: optionalBoolean, result: optionalString,
  duration_ms: optionalNumber, total_cost_usd: optionalNumber, num_turns: optionalNumber, cost_usd: optionalNumber, thinking: optionalString,
  tools: boundary.optional(boundary.array(boundary.object({ name: boundary.string, description: optionalString, input_schema: boundary.optional(boundary.jsonObject) }))),
  mcp_servers: boundary.optional(boundary.array(boundary.object({ name: boundary.string, command: optionalString, args: boundary.optional(boundary.array(boundary.string)) }))),
});

export const remoteSessionSchema: BoundarySchema<Session> = boundary.object({
  id: boundary.nonEmptyString, name: boundary.string, worktreePath: boundary.string, prompt: boundary.string,
  status: boundary.enumeration('initializing', 'ready', 'running', 'waiting', 'stopped', 'error'),
  createdAt: boundary.string, output: boundary.array(boundary.string), jsonMessages: boundary.array(remoteMessageSchema),
  statusMessage: optionalString, pid: optionalNumber, lastActivity: optionalString, error: optionalString,
  isRunning: optionalBoolean, lastViewedAt: optionalString, projectId: optionalNumber, folderId: optionalString,
  permissionMode: boundary.optional(boundary.enumeration('approve', 'ignore')), runStartedAt: optionalString,
  isMainRepo: optionalBoolean, worktreeOwnership: boundary.optional(boundary.enumeration('pane', 'external')),
  displayOrder: optionalNumber, isFavorite: optionalBoolean, favoritePinnedAt: optionalString,
  toolType: boundary.optional(boundary.enumeration('claude', 'none')), archived: optionalBoolean, isHidden: optionalBoolean,
  baseCommit: optionalString, baseBranch: optionalString, activateOnCreate: optionalBoolean, createDefaultTerminalOnCreate: optionalBoolean,
  gitStatus: boundary.optional(boundary.object({
    state: boundary.enumeration('clean', 'modified', 'untracked', 'ahead', 'behind', 'diverged', 'conflict', 'unknown'),
    ahead: optionalNumber, behind: optionalNumber, additions: optionalNumber, deletions: optionalNumber,
    filesChanged: optionalNumber, lastChecked: optionalString, isReadyToMerge: optionalBoolean,
    hasUncommittedChanges: optionalBoolean, hasUntrackedFiles: optionalBoolean,
    secondaryStates: boundary.optional(boundary.array(boundary.enumeration('modified', 'untracked', 'ahead', 'behind'))),
    commitAdditions: optionalNumber, commitDeletions: optionalNumber, commitFilesChanged: optionalNumber, totalCommits: optionalNumber,
    prNumber: optionalNumber, prUrl: optionalString, prTitle: optionalString, prState: optionalString, prIsDraft: optionalBoolean, prBody: optionalString,
  })),
});
export const remoteDeletedSessionSchema = boundary.object({ id: boundary.nonEmptyString });
