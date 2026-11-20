import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { SESSION_MOVE_MANIFEST_VERSION } from '../../../../shared/types/sessionMove';
import { FILE_STORE_AGENTS, type FileStoreAgent } from '../../../../packages/runpane/src/nativeSession';
import type { MovedApproval } from '../notify/notifyService';

/**
 * The package a source sends: one manifest naming every file it carries with its size and
 * SHA-256, so the target can check everything before it builds anything. Paths inside the
 * package are relative and use `/`.
 */

/** A file in the package. `bytes` and `sha256` are of the original content, before compression. */
export interface PackageFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** Which agent store a conversation file belongs in on the target. */
export type ConversationStore = FileStoreAgent;

/** One conversation file: where it is in the package and where it goes under its store. */
export interface ConversationFile {
  package: string;
  /** `project`: under Claude's `projects/<folder for the tab's cwd>/`; `store`: under the store root. */
  scope: 'project' | 'store';
  relative: string;
}

export interface MoveConversation {
  store: ConversationStore;
  /** The agent's conversation id: what the tab resumes. */
  id: string;
  files: ConversationFile[];
}

export interface MoveTab {
  id: string;
  type: string;
  title: string;
  metadata: JsonObject;
  /** The tab's custom state as saved, minus its terminal buffers (they travel in `buffers`). */
  state: JsonObject;
  /** Whether it was mid-turn when the move started waiting, and whether Stop now cut that turn off. */
  working: boolean;
  interrupted: boolean;
  /** Whether its agent was running before the move stopped it; only those start again on the target. */
  running: boolean;
  conversation?: MoveConversation;
  /** Package path of the tab's saved scrollback, as JSON `{ scrollback, serialized, alternate }`. */
  buffers?: string;
}

export interface MoveRepo {
  /** `git remote get-url origin`, or null for a repository with no origin. */
  remote: string | null;
  /** The remote normalised to host/owner/repo (`repositoryIdentityFromRemote`), for matching on the target. */
  identity: string | null;
  /** The repository's root on the source, and its path relative to the source home when it is under it. */
  root: string;
  relativeToHome: string | null;
  name: string;
}

export interface MovePane {
  id: string;
  name: string;
  /** `owner`: the Session's hidden Pane, whose folder is the Session folder. */
  role: 'owner' | 'member';
  repo: MoveRepo | null;
  worktreePath: string;
  worktreeName: string;
  branch: string | null;
  head: string | null;
  baseBranch: string | null;
  baseCommit: string | null;
  snapshot: { ref: string; commit: string } | null;
  /** Package path of the git bundle. */
  bundle: string | null;
  /** The saved split layout (JSON text), or null. */
  layout: string | null;
  /** The Pane's own record fields that carry over. */
  record: { prompt: string; permissionMode: 'approve' | 'ignore'; noTool: boolean };
  tabs: MoveTab[];
  /** Ignored entries that stay behind (rebuilt by setup on the target). */
  ignored: string[];
}

export interface MoveManifest {
  version: number;
  moveId: string;
  source: {
    machine: string;
    home: string;
    paneDir: string;
    platform: string;
    paneVersion: string;
    /** Installed agent CLI versions (`claude --version` …), null when missing. */
    agentVersions: Record<string, string | null>;
    /** Agent Farm profiles the tabs launch, with their versions. */
    profiles: Record<string, string | null>;
    /** Env var names the Session's Panes have set here. */
    envNames: string[];
  };
  /** The Session record as saved (JSON). */
  session: JsonObject;
  sessionFolder: { root: string; files: string[] };
  panes: MovePane[];
  /** Waiting approvals the move carries (T-44): each a MovedApproval, read with `movedApprovals`. */
  approvals: JsonObject[];
  files: PackageFile[];
}

/** A Pane's own record fields that travel. */
const paneRecordSchema = boundary.object({
  prompt: boundary.string,
  permissionMode: boundary.enumeration('approve', 'ignore'),
  /** True when the Pane runs no tool of its own (a plain worktree). */
  noTool: boundary.boolean,
});

/** Scrollback saved with a terminal tab. */
export const panelBuffersSchema = boundary.object({
  scrollback: boundary.nullable(boundary.string),
  serialized: boundary.nullable(boundary.string),
  alternate: boundary.nullable(boundary.string),
});

const packageFileSchema = boundary.object({ path: boundary.nonEmptyString, bytes: boundary.number, sha256: boundary.string });
const tabSchema = boundary.object({
  id: boundary.nonEmptyString,
  type: boundary.nonEmptyString,
  title: boundary.string,
  metadata: boundary.jsonObject,
  state: boundary.jsonObject,
  working: boundary.boolean,
  interrupted: boundary.boolean,
  running: boundary.boolean,
  conversation: boundary.optional(boundary.object({
    store: boundary.enumeration(...FILE_STORE_AGENTS),
    id: boundary.nonEmptyString,
    files: boundary.array(boundary.object({ package: boundary.nonEmptyString, scope: boundary.enumeration('project', 'store'), relative: boundary.nonEmptyString })),
  })),
  buffers: boundary.optional(boundary.nonEmptyString),
});
const repoSchema = boundary.object({
  remote: boundary.nullable(boundary.string),
  identity: boundary.nullable(boundary.string),
  root: boundary.nonEmptyString,
  relativeToHome: boundary.nullable(boundary.string),
  name: boundary.string,
});
const paneSchema = boundary.object({
  id: boundary.nonEmptyString,
  name: boundary.string,
  role: boundary.enumeration('owner', 'member'),
  repo: boundary.nullable(repoSchema),
  worktreePath: boundary.nonEmptyString,
  worktreeName: boundary.string,
  branch: boundary.nullable(boundary.string),
  head: boundary.nullable(boundary.string),
  baseBranch: boundary.nullable(boundary.string),
  baseCommit: boundary.nullable(boundary.string),
  snapshot: boundary.nullable(boundary.object({ ref: boundary.nonEmptyString, commit: boundary.nonEmptyString })),
  bundle: boundary.nullable(boundary.string),
  layout: boundary.nullable(boundary.string),
  record: paneRecordSchema,
  tabs: boundary.array(tabSchema),
  ignored: boundary.array(boundary.string),
});
const nullableStringRecord = boundary.record(boundary.nullable(boundary.string));

export const moveManifestSchema = boundary.object({
  version: boundary.refine(boundary.number, value => value === SESSION_MOVE_MANIFEST_VERSION, `expected manifest version ${SESSION_MOVE_MANIFEST_VERSION}`),
  moveId: boundary.refine(boundary.nonEmptyString, value => /^[A-Za-z0-9-]{8,64}$/.test(value), 'expected a move id'),
  source: boundary.object({
    machine: boundary.nonEmptyString,
    home: boundary.nonEmptyString,
    paneDir: boundary.nonEmptyString,
    platform: boundary.string,
    paneVersion: boundary.string,
    agentVersions: nullableStringRecord,
    profiles: nullableStringRecord,
    envNames: boundary.array(boundary.string),
  }),
  session: boundary.jsonObject,
  sessionFolder: boundary.object({ root: boundary.nonEmptyString, files: boundary.array(boundary.string) }),
  panes: boundary.array(paneSchema),
  approvals: boundary.array(boundary.jsonObject),
  files: boundary.array(packageFileSchema),
});

/** A package path is relative, uses `/`, and never climbs out of the package. */
export function isSafePackagePath(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
  return value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

/** The few fields of a tab's saved state a move reads; anything else travels untouched. */
const tabFieldsSchema = boundary.object({
  agentType: boundary.optional(boundary.string),
  agent: boundary.optional(boundary.string),
  agentSessionId: boundary.optional(boundary.string),
  acpSessionId: boundary.optional(boundary.string),
  launchCommand: boundary.optional(boundary.string),
  initialCommand: boundary.optional(boundary.string),
  resumeDirectory: boundary.optional(boundary.string),
});

/** What a move reads of a tab: its agent, the conversation it resumes, and its launch command. */
export interface TabInfo {
  agentId?: string;
  conversationId?: string;
  launch?: string;
  resumeDirectory?: string;
}

/** A tab's agent, conversation id and launch command, from its saved state (terminal or chat). */
export function readTabFields(state: JsonObject): TabInfo {
  const fields = decodeOptionalBoundary(state, tabFieldsSchema) ?? decodeBoundary({}, tabFieldsSchema);
  return {
    agentId: fields.agentType ?? fields.agent,
    conversationId: fields.agentSessionId ?? fields.acpSessionId,
    launch: fields.launchCommand ?? fields.initialCommand,
    resumeDirectory: fields.resumeDirectory,
  };
}

/**
 * A serializer: the JSON copy of a saved record (a Session, a panel's state, a manifest), parsed
 * back with the JSON-object schema, so what travels is exactly what JSON can carry.
 */
export function toJsonObject<Value extends object>(value: Value): JsonObject {
  return decodeBoundary(JSON.parse(JSON.stringify(value)), boundary.jsonObject);
}

/** A fix the target offers for a blocking check, as `SessionMoveFix`. */
export const sessionMoveFixSchema = boundary.union(
  boundary.object({ kind: boundary.enumeration('clone'), label: boundary.string, remote: boundary.nonEmptyString, path: boundary.nonEmptyString }),
  boundary.object({ kind: boundary.enumeration('trust'), label: boundary.string, path: boundary.nonEmptyString }),
);

export const sessionMoveCheckSchema = boundary.object({
  id: boundary.string,
  level: boundary.enumeration('ok', 'warning', 'block'),
  title: boundary.string,
  detail: boundary.optional(boundary.string),
  fix: boundary.optional(sessionMoveFixSchema),
});

const movedApprovalSchema = boundary.object({
  item: boundary.object({
    id: boundary.nonEmptyString, title: boundary.string, state: boundary.literal('waiting'),
    source: boundary.object({ panelId: boundary.nonEmptyString }),
  }),
  report: boundary.optional(boundary.object({ id: boundary.nonEmptyString, sessionId: boundary.nonEmptyString, panelId: boundary.nonEmptyString })),
});

/**
 * A manifest's approvals, checked: each a waiting card with the tab its answer goes to, and never a
 * secret, lease or permission prompt, which stay on the machine that asked (rules.ts `sessionApprovals`).
 */
export function movedApprovals(values: readonly JsonObject[]): MovedApproval[] {
  return values.map(value => {
    const checked = decodeBoundary(value, movedApprovalSchema);
    const item = decodeBoundary(value.item, boundary.jsonObject);
    if ('secret' in item || 'lease' in item || 'agentPrompt' in item) throw new Error(`Approval ${checked.item.id} is a kind that can't move.`);
    if (checked.report && checked.report.id !== checked.item.id) throw new Error(`Approval ${checked.item.id} came with another question's inbox item.`);
    // SAFETY: checked above, and written by the source's Pane from its own NotifyItem and RunpaneInboxItem; the queue and inbox save them as they would their own.
    return JSON.parse(JSON.stringify(value)) as MovedApproval;
  });
}
