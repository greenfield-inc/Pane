import { customCommandResumeSchema } from '../../../shared/types/customCommandResume';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  boundary,
  BoundaryDecodeError,
  decodeBoundary,
  decodeOptionalBoundary,
  type BoundarySchema,
  type JsonObject,
  type JsonValue,
} from '../../../shared/validation/boundaryDecoder';
import {
  LEGACY_ORCHESTRATION_SESSION_ID,
  ORCHESTRATION_SESSION_STORE_VERSION,
  type OrchestrationActivity,
  type OrchestrationAssociation,
  type OrchestrationLink,
  type OrchestrationReport,
  type OrchestrationSessionRecord,
  type OrchestrationSessionStoreData,
} from '../../../shared/types/orchestrationSession';
import { getPaneChatPanelId } from '../../../shared/types/paneChat';

const paneChatAgentSchema = boundary.enumeration('claude', 'codex', 'cursor', 'opencode');
const sourceSchema = boundary.enumeration('user', 'agent', 'system');
const activityKindSchema = boundary.enumeration(
  'created',
  'updated',
  'associated',
  'detached',
  'working',
  'blocked',
  'idle',
  'unknown',
  'report',
);
const linkKindSchema = boundary.enumeration('evidence', 'output', 'ticket', 'pull-request', 'other');
const timestampSchema = boundary.refine(boundary.nonEmptyString, value => Number.isFinite(Date.parse(value)), 'expected a timestamp');

const linkSchema: BoundarySchema<OrchestrationLink> = boundary.object({
  label: boundary.nonEmptyString,
  url: boundary.refine(
    boundary.nonEmptyString,
    value => /^(?:https?:\/\/|file:\/\/|grain:\/\/)/i.test(value),
    'URL must use https, file, or grain scheme',
  ),
  kind: boundary.optional(linkKindSchema),
  provenance: boundary.optional(boundary.string),
  addedAt: timestampSchema,
});

const reportSchema: BoundarySchema<OrchestrationReport> = boundary.object({
  summary: boundary.nonEmptyString,
  status: boundary.enumeration('reported', 'verified'),
  evidence: boundary.refine(boundary.array(linkSchema), links => links.length > 0, 'report needs evidence'),
  reportedAt: timestampSchema,
  provenance: boundary.nonEmptyString,
});

const associationSchema: BoundarySchema<OrchestrationAssociation> = boundary.object({
  paneId: boundary.nonEmptyString,
  panelIds: boundary.array(boundary.nonEmptyString),
  attachedAt: timestampSchema,
});

const activitySchema: BoundarySchema<OrchestrationActivity> = boundary.object({
  id: boundary.nonEmptyString,
  kind: activityKindSchema,
  message: boundary.string,
  at: timestampSchema,
  source: sourceSchema,
  paneId: boundary.optional(boundary.nonEmptyString),
  panelId: boundary.optional(boundary.nonEmptyString),
});

const sessionSchema = boundary.object({
  runtime: boundary.optional(boundary.enumeration('windows', 'wsl')),
  wslDistribution: boundary.optional(boundary.nonEmptyString),
  promotedFrom: boundary.optional(boundary.object({ paneId: boundary.nonEmptyString, panelId: boundary.nonEmptyString })),
  id: boundary.nonEmptyString,
  name: boundary.nonEmptyString,
  nameIsDefault: boundary.optional(boundary.boolean),
  archived: boundary.optional(boundary.boolean),
  isPinned: boundary.optional(boundary.boolean),
  agent: paneChatAgentSchema,
  launchCommand: boundary.optional(boundary.string),
  customResume: boundary.optional(boundary.nullable(customCommandResumeSchema)),
  resume: boundary.optional(boundary.nonEmptyString),
  openingPrompt: boundary.optional(boundary.nonEmptyString),
  profile: boundary.optional(boundary.string),
  internalSessionId: boundary.nonEmptyString,
  panelIds: boundary.object({
    claude: boundary.nonEmptyString,
    codex: boundary.nonEmptyString,
    cursor: boundary.nonEmptyString,
    opencode: boundary.optional(boundary.nonEmptyString),
  }),
  goal: boundary.string,
  context: boundary.string,
  decisions: boundary.array(boundary.string),
  blockers: boundary.array(boundary.string),
  nextAction: boundary.string,
  evidence: boundary.array(linkSchema),
  outputs: boundary.array(linkSchema),
  associations: boundary.array(associationSchema),
  activity: boundary.array(activitySchema),
  report: boundary.optional(reportSchema),
  reportActivityId: boundary.optional(boundary.nonEmptyString),
  reportAcceptedAt: boundary.optional(timestampSchema),
  revision: boundary.refine(boundary.number, value => Number.isInteger(value) && value >= 0, 'expected a non-negative integer'),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** Session list fields whose bad entries are dropped one by one. */
const SESSION_LIST_FIELDS: ReadonlyArray<[string, BoundarySchema<unknown>]> = [
  ['decisions', boundary.string],
  ['blockers', boundary.string],
  ['evidence', linkSchema],
  ['outputs', linkSchema],
  ['associations', associationSchema],
  ['activity', activitySchema],
];

/** A Session's identity and membership, without its history (see `memberships`). */
export interface OrchestrationSessionMembership {
  id: string;
  name: string;
  internalSessionId: string;
  archived: boolean;
  panelIds: string[];
  associations: Array<{ paneId: string; panelIds: string[] }>;
}

export class OrchestrationSessionStore {
  private loaded = false;
  private data: OrchestrationSessionStoreData = emptyStore();

  constructor(
    private readonly filePath: string,
  ) {}

  read(): OrchestrationSessionStoreData {
    this.ensureLoaded();
    return cloneStore(this.data);
  }

  /**
   * Who each Session is and which Panes it owns, copied without its history: Approvals looks
   * Sessions up on hot paths, where cloning every Session's activity would cost far more.
   */
  memberships(): OrchestrationSessionMembership[] {
    this.ensureLoaded();
    return this.data.sessions.map(session => ({
      id: session.id,
      name: session.name,
      internalSessionId: session.internalSessionId,
      archived: session.archived === true,
      panelIds: Object.values(session.panelIds),
      associations: session.associations.map(association => ({ paneId: association.paneId, panelIds: [...association.panelIds] })),
    }));
  }

  /**
   * Validate and atomically publish a complete snapshot. Callers must pass a
   * newly-created value; the in-memory snapshot is changed only after the
   * rename succeeds so readers never observe a mutation that failed to land.
   */
  write(next: OrchestrationSessionStoreData): void {
    this.ensureLoaded();
    const problems: string[] = [];
    const validated = sanitizeStore(next, problems);
    if (problems.length > 0) throw new Error(`Invalid orchestration Session store write: ${problems.join('; ')}`);
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
      this.data = cloneStore(validated);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  /**
   * Loads fail open: every Session that decodes is kept and bad entries are dropped. Only a file
   * that is not JSON starts empty. Either way the original is copied aside first and stays in
   * place until the next write.
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && isFileMissing(error))) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to read orchestration Session store ${this.filePath}: ${message}`);
      }
      this.data = emptyStore();
      this.loaded = true;
      return;
    }
    const problems: string[] = [];
    try {
      this.data = sanitizeStore(decodeBoundary(JSON.parse(raw), boundary.json), problems);
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof BoundaryDecodeError)) throw error;
      problems.push(`the file is not JSON (${error.message}); starting with no Sessions`);
      this.data = emptyStore();
    }
    if (problems.length > 0) {
      const backupPath = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(this.filePath, backupPath);
      console.warn(`[OrchestrationSessionStore] Loaded ${this.filePath} with problems; the original is saved as ${backupPath}: ${problems.join('; ')}`);
    }
    this.loaded = true;
  }
}

/**
 * Decodes a store, dropping or repairing each bad entry and describing it in `problems`. The
 * sessions array is taken whatever the version or other envelope fields say.
 */
function sanitizeStore(value: JsonValue | OrchestrationSessionStoreData, problems: string[]): OrchestrationSessionStoreData {
  const envelope = decodeOptionalBoundary(value, boundary.jsonObject) ?? {};
  if (envelope.version !== ORCHESTRATION_SESSION_STORE_VERSION) {
    problems.push(`read a store marked version ${JSON.stringify(envelope.version) ?? 'missing'} as version ${ORCHESTRATION_SESSION_STORE_VERSION}`);
  }
  const entries = decodeOptionalBoundary(envelope.sessions, boundary.array(boundary.json));
  if (!entries) problems.push('found no sessions array');
  const selectedSessionId = optionalField(envelope.selectedSessionId, boundary.nonEmptyString, 'selectedSessionId', problems);
  const order = optionalField(envelope.order, boundary.array(boundary.nonEmptyString), 'order', problems);
  const sessions: OrchestrationSessionRecord[] = [];
  const ids = new Set<string>();
  (entries ?? []).forEach((entry, index) => {
    const session = sanitizeSession(entry, index, problems);
    if (!session) return;
    if (ids.has(session.id)) {
      problems.push(`dropped a duplicate of Session ${session.id}`);
      return;
    }
    ids.add(session.id);
    sessions.push(session);
  });
  const data: OrchestrationSessionStoreData = { version: ORCHESTRATION_SESSION_STORE_VERSION, sessions };
  if (selectedSessionId !== undefined) {
    if (ids.has(selectedSessionId)) data.selectedSessionId = selectedSessionId;
    else problems.push(`cleared the selection of missing Session ${selectedSessionId}`);
  }
  // The order is a preference, not a record: forget ids of Sessions that no longer exist.
  if (order) data.order = [...new Set(order)].filter(id => ids.has(id));
  return data;
}

/** An optional envelope field; a present value that fails `schema` is dropped. */
function optionalField<Value>(value: JsonValue | undefined, schema: BoundarySchema<Value>, label: string, problems: string[]): Value | undefined {
  if (value === undefined) return undefined;
  const decoded = decodeOptionalBoundary(value, schema);
  if (decoded === undefined) problems.push(`dropped an invalid ${label}`);
  return decoded;
}

function sanitizeSession(value: JsonValue, index: number, problems: string[]): OrchestrationSessionRecord | undefined {
  const entry = decodeOptionalBoundary(value, boundary.jsonObject);
  if (!entry) {
    problems.push(`dropped Session entry ${index}: expected an object`);
    return undefined;
  }
  const label = `Session ${decodeOptionalBoundary(entry.id, boundary.nonEmptyString) ?? `entry ${index}`}`;
  const fields: JsonObject = { ...entry };
  for (const [key, schema] of SESSION_LIST_FIELDS) {
    fields[key] = keepValidEntries(entry[key], schema, `${label} ${key}`, problems);
  }
  if (fields.report !== undefined && !decodes(fields.report, reportSchema, `${label} report`, problems)) delete fields.report;
  if (fields.report === undefined) {
    if (fields.reportActivityId !== undefined) problems.push(`${label}: dropped a report activity marker without a report`);
    if (fields.reportAcceptedAt !== undefined) problems.push(`${label}: dropped a report acceptance timestamp without a report`);
    delete fields.reportActivityId;
    delete fields.reportAcceptedAt;
  }
  // A bad OpenCode panel id is replaced by the derived one rather than dropping the Session.
  const panelIds = decodeOptionalBoundary(fields.panelIds, boundary.jsonObject);
  if (panelIds?.opencode !== undefined && decodeOptionalBoundary(panelIds.opencode, boundary.nonEmptyString) === undefined) {
    problems.push(`${label}: replaced an invalid OpenCode panel id`);
    fields.panelIds = Object.fromEntries(Object.entries(panelIds).filter(([agent]) => agent !== 'opencode'));
  }
  if (fields.runtime === 'wsl' && decodeOptionalBoundary(fields.wslDistribution, boundary.nonEmptyString) === undefined) {
    problems.push(`dropped ${label}: a WSL Session requires a distribution`);
    return undefined;
  }
  // Omitted runtime means the native host; 'windows' is a legacy alias for it.
  if (fields.runtime === 'windows') delete fields.runtime;
  if (fields.runtime !== 'wsl' && fields.wslDistribution !== undefined) {
    problems.push(`${label}: dropped the WSL distribution of a native Session`);
    delete fields.wslDistribution;
  }
  try {
    const session = decodeBoundary(fields, sessionSchema);
    // Sessions saved before OpenCode joined get its derived panel id.
    const opencode = session.panelIds.opencode ?? (session.id === LEGACY_ORCHESTRATION_SESSION_ID
      ? getPaneChatPanelId('opencode') : `__orchestration_panel_${session.id}_opencode`);
    return { ...session, panelIds: { ...session.panelIds, opencode } };
  } catch (error) {
    if (!(error instanceof BoundaryDecodeError)) throw error;
    problems.push(`dropped ${label}: ${error.message}`);
    return undefined;
  }
}

/** A missing or non-array list becomes empty; entries that fail `schema` are dropped. */
function keepValidEntries(value: JsonValue | undefined, schema: BoundarySchema<unknown>, label: string, problems: string[]): JsonValue[] {
  if (!Array.isArray(value)) {
    problems.push(`${label}: replaced a missing or non-list value with an empty list`);
    return [];
  }
  return value.filter((item, index) => decodes(item, schema, `${label}[${index}]`, problems));
}

function decodes(value: JsonValue, schema: BoundarySchema<unknown>, label: string, problems: string[]): boolean {
  try {
    decodeBoundary(value, schema);
    return true;
  } catch (error) {
    if (!(error instanceof BoundaryDecodeError)) throw error;
    problems.push(`dropped ${label}: ${error.message}`);
    return false;
  }
}

function emptyStore(): OrchestrationSessionStoreData {
  return { version: ORCHESTRATION_SESSION_STORE_VERSION, sessions: [] };
}

function cloneStore(value: OrchestrationSessionStoreData): OrchestrationSessionStoreData {
  // SAFETY: Store values have just passed the versioned boundary schema and contain JSON data only.
  return JSON.parse(JSON.stringify(value)) as OrchestrationSessionStoreData;
}

interface FileSystemError extends Error {
  code?: string;
}

function isFileMissing(error: Error): error is FileSystemError {
  // SAFETY: Node filesystem errors expose an optional string `code` property.
  return (error as FileSystemError).code === 'ENOENT';
}
