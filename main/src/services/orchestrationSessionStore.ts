import { customCommandResumeSchema } from '../../../shared/types/customCommandResume';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import {
  boundary,
  decodeBoundary,
  type BoundarySchema,
} from '../../../shared/validation/boundaryDecoder';
import {
  MAX_ORCHESTRATION_ACTIVITY,
  MAX_ORCHESTRATION_ITEMS,
  MAX_ORCHESTRATION_TEXT_LENGTH,
  ORCHESTRATION_SESSION_STORE_VERSION,
  type OrchestrationActivity,
  type OrchestrationAssociation,
  type OrchestrationLink,
  type OrchestrationReport,
  type OrchestrationSessionRecord,
  type OrchestrationSessionStoreData,
} from '../../../shared/types/orchestrationSession';
import type { JsonValue } from '../../../shared/validation/boundaryDecoder';

const paneChatAgentSchema = boundary.enumeration('claude', 'codex', 'cursor');
const MAX_STORE_BYTES = 2_000_000;
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

const linkSchema: BoundarySchema<OrchestrationLink> = boundary.object({
  label: boundary.nonEmptyString,
  url: boundary.nonEmptyString,
  kind: boundary.optional(linkKindSchema),
  provenance: boundary.optional(boundary.string),
  addedAt: boundary.nonEmptyString,
});

const reportSchema: BoundarySchema<OrchestrationReport> = boundary.object({
  summary: boundary.nonEmptyString,
  status: boundary.enumeration('reported', 'verified'),
  evidence: boundary.array(linkSchema),
  reportedAt: boundary.nonEmptyString,
  provenance: boundary.nonEmptyString,
});

const associationSchema: BoundarySchema<OrchestrationAssociation> = boundary.object({
  paneId: boundary.nonEmptyString,
  panelIds: boundary.array(boundary.nonEmptyString),
  attachedAt: boundary.nonEmptyString,
});

const activitySchema: BoundarySchema<OrchestrationActivity> = boundary.object({
  id: boundary.nonEmptyString,
  kind: activityKindSchema,
  message: boundary.string,
  at: boundary.nonEmptyString,
  source: sourceSchema,
  paneId: boundary.optional(boundary.nonEmptyString),
  panelId: boundary.optional(boundary.nonEmptyString),
});

const sessionSchema: BoundarySchema<OrchestrationSessionRecord> = boundary.object({
  promotedFrom: boundary.optional(boundary.object({ paneId: boundary.nonEmptyString, panelId: boundary.nonEmptyString })),
  id: boundary.nonEmptyString,
  name: boundary.nonEmptyString,
  archived: boundary.optional(boundary.boolean),
  isPinned: boundary.optional(boundary.boolean),
  agent: paneChatAgentSchema,
  launchCommand: boundary.optional(boundary.string),
  customResume: boundary.optional(boundary.nullable(customCommandResumeSchema)),
  profile: boundary.optional(boundary.string),
  internalSessionId: boundary.nonEmptyString,
  panelIds: boundary.object({
    claude: boundary.nonEmptyString,
    codex: boundary.nonEmptyString,
    cursor: boundary.nonEmptyString,
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
  reportAcceptedAt: boundary.optional(boundary.nonEmptyString),
  revision: boundary.number,
  createdAt: boundary.nonEmptyString,
  updatedAt: boundary.nonEmptyString,
});

const storeSchema: BoundarySchema<OrchestrationSessionStoreData> = boundary.object({
  version: boundary.literal(ORCHESTRATION_SESSION_STORE_VERSION),
  selectedSessionId: boundary.optional(boundary.nonEmptyString),
  sessions: boundary.array(sessionSchema),
});

export class OrchestrationSessionStore {
  private loaded = false;
  private data: OrchestrationSessionStoreData = {
    version: ORCHESTRATION_SESSION_STORE_VERSION,
    sessions: [],
  };

  constructor(
    private readonly filePath: string,
  ) {}

  read(): OrchestrationSessionStoreData {
    this.ensureLoaded();
    return cloneStore(this.data);
  }

  /**
   * Validate and atomically publish a complete snapshot. Callers must pass a
   * newly-created value; the in-memory snapshot is changed only after the
   * rename succeeds so readers never observe a mutation that failed to land.
   */
  write(next: OrchestrationSessionStoreData): void {
    this.ensureLoaded();
    const validated = validateStore(next);
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const payload = `${JSON.stringify(validated, null, 2)}\n`;
      if (Buffer.byteLength(payload, 'utf8') > MAX_STORE_BYTES) {
        throw new Error(`orchestration Session store exceeds ${MAX_STORE_BYTES} bytes`);
      }
      fs.writeFileSync(temporaryPath, payload, { mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
      this.data = cloneStore(validated);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_STORE_BYTES) {
        throw new Error(`orchestration Session store exceeds ${MAX_STORE_BYTES} bytes`);
      }
      const parsed = decodeBoundary(JSON.parse(raw), boundary.json);
      this.data = validateStore(parsed);
    } catch (error) {
      if (error instanceof Error && isFileMissing(error)) {
        this.data = {
          version: ORCHESTRATION_SESSION_STORE_VERSION,
          sessions: [],
        };
      } else {
        const message = error instanceof Error ? errorMessage(error) : String(error);
        throw new Error(`Unable to read orchestration Session store ${this.filePath}: ${message}`);
      }
    }
    this.loaded = true;
  }
}

function validateStore(value: JsonValue | OrchestrationSessionStoreData): OrchestrationSessionStoreData {
  const decoded = decodeBoundary(value, storeSchema);
  if (decoded.sessions.length > MAX_ORCHESTRATION_ITEMS) {
    throw new Error(`orchestration Session store contains more than ${MAX_ORCHESTRATION_ITEMS} Sessions`);
  }
  const ids = new Set<string>();
  for (const session of decoded.sessions) {
    validateSession(session);
    if (ids.has(session.id)) throw new Error(`orchestration Session store contains duplicate id ${session.id}`);
    ids.add(session.id);
  }
  if (decoded.selectedSessionId && !ids.has(decoded.selectedSessionId)) {
    throw new Error(`orchestration Session store selects missing Session ${decoded.selectedSessionId}`);
  }
  return decoded;
}

function validateSession(session: OrchestrationSessionRecord): void {
  validateText(session.id, `Session ${session.id} id`);
  validateText(session.name, `Session ${session.id} name`);
  validateText(session.internalSessionId, `Session ${session.id} internal id`);
  Object.values(session.panelIds).forEach(panelId => validateText(panelId, `Session ${session.id} panel id`));
  if (!Number.isInteger(session.revision) || session.revision < 0) {
    throw new Error(`Session ${session.id} has an invalid revision`);
  }
  for (const value of [session.goal, session.context, session.nextAction, session.launchCommand ?? '', session.profile ?? '']) {
    validateText(value, `Session ${session.id}`);
  }
  validateTextArray(session.decisions, `Session ${session.id} decisions`);
  validateTextArray(session.blockers, `Session ${session.id} blockers`);
  validateLinks(session.evidence, `Session ${session.id} evidence`);
  validateLinks(session.outputs, `Session ${session.id} outputs`);
  if (session.report) {
    validateText(session.report.summary, `Session ${session.id} report`);
    validateLinks(session.report.evidence, `Session ${session.id} report evidence`);
    if (session.report.evidence.length === 0) throw new Error(`Session ${session.id} report needs evidence`);
    validateTimestamp(session.report.reportedAt, `Session ${session.id} report timestamp`);
  }
  if (session.reportActivityId !== undefined) {
    if (!session.report) throw new Error(`Session ${session.id} has a report activity marker without a report`);
    validateText(session.reportActivityId, `Session ${session.id} report activity id`);
  }
  if (session.reportAcceptedAt !== undefined) {
    if (!session.report) throw new Error(`Session ${session.id} has a report acceptance timestamp without a report`);
    validateTimestamp(session.reportAcceptedAt, `Session ${session.id} report acceptance timestamp`);
  }
  if (session.associations.length > MAX_ORCHESTRATION_ITEMS) {
    throw new Error(`Session ${session.id} has too many Pane associations`);
  }
  for (const association of session.associations) {
    if (association.panelIds.length > MAX_ORCHESTRATION_ITEMS) {
      throw new Error(`Session ${session.id} has too many associated panels`);
    }
    validateTimestamp(association.attachedAt, `Session ${session.id} association timestamp`);
  }
  if (session.activity.length > MAX_ORCHESTRATION_ACTIVITY) {
    throw new Error(`Session ${session.id} has more than ${MAX_ORCHESTRATION_ACTIVITY} activity entries`);
  }
  for (const activity of session.activity) {
    validateText(activity.message, `Session ${session.id} activity`);
    validateTimestamp(activity.at, `Session ${session.id} activity timestamp`);
  }
  validateTimestamp(session.createdAt, `Session ${session.id} created timestamp`);
  validateTimestamp(session.updatedAt, `Session ${session.id} updated timestamp`);
}

function validateLinks(links: OrchestrationLink[], label: string): void {
  if (links.length > MAX_ORCHESTRATION_ITEMS) throw new Error(`${label} contains too many links`);
  for (const link of links) {
    validateText(link.label, `${label} label`);
    validateText(link.url, `${label} URL`);
    validateTimestamp(link.addedAt, `${label} timestamp`);
    if (!/^(?:https?:\/\/|file:\/\/|grain:\/\/)/i.test(link.url)) {
      throw new Error(`${label} URL must use https, file, or grain scheme`);
    }
    if (link.provenance !== undefined) validateText(link.provenance, `${label} provenance`);
  }
}

function validateTextArray(values: string[], label: string): void {
  if (values.length > MAX_ORCHESTRATION_ITEMS) throw new Error(`${label} contains too many entries`);
  values.forEach(value => validateText(value, label));
}

function validateText(value: string, label: string): void {
  if (value.length > MAX_ORCHESTRATION_TEXT_LENGTH) throw new Error(`${label} exceeds text limit`);
}

function validateTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
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

function errorMessage(error: Error): string {
  return error.message;
}
