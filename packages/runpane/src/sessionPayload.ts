import { boundary, BoundaryDecodeIssues, decodeBoundaryAll } from './boundaryDecoder';
import { RunpaneError } from './errors';
import type { BoundarySchema, JsonValue } from './boundaryDecoder';

/**
 * The Session create/update payload that people and agents write by hand for
 * `runpane sessions create|update --from-json`. Every problem is reported at once, and the link
 * URL scheme and dates are checked before anything reaches Pane. The daemon applies the
 * same rules (main/src/services/orchestrationSessionPayload.ts); keep the two in step.
 */
const LINK_URL_PATTERN = /^(?:https?:\/\/|file:\/\/|grain:\/\/)/i;

const isoDateSchema = boundary.refine(
  boundary.nonEmptyString,
  value => Number.isFinite(Date.parse(value)),
  'expected an ISO 8601 date such as 2026-10-14T09:30:00Z',
);
const textSchema = boundary.string;
const textArraySchema = boundary.array(textSchema);
const linkSchema = boundary.object({
  label: boundary.nonEmptyString,
  url: boundary.refine(
    boundary.nonEmptyString,
    value => LINK_URL_PATTERN.test(value),
    'expected a URL starting with https://, http://, file:// or grain://',
  ),
  kind: boundary.optional(boundary.enumeration('evidence', 'output', 'ticket', 'pull-request', 'other')),
  provenance: boundary.optional(textSchema),
  addedAt: isoDateSchema,
});
const linksSchema = boundary.array(linkSchema);
const reportSchema = boundary.object({
  summary: boundary.nonEmptyString,
  status: boundary.enumeration('reported', 'verified'),
  evidence: boundary.refine(linksSchema, links => links.length > 0, 'expected at least one link'),
  reportedAt: isoDateSchema,
  provenance: boundary.nonEmptyString,
});
const agentSchema = boundary.enumeration('codex', 'claude', 'cursor');

const sessionCreatePayloadSchema = boundary.object({
  runtime: boundary.optional(boundary.enumeration('windows', 'wsl')),
  wslDistribution: boundary.optional(boundary.nonEmptyString),
  name: boundary.nonEmptyString,
  isPinned: boundary.optional(boundary.boolean),
  agent: boundary.optional(agentSchema),
  launchCommand: boundary.optional(textSchema),
  profile: boundary.optional(textSchema),
  goal: boundary.optional(textSchema),
  context: boundary.optional(textSchema),
  decisions: boundary.optional(textArraySchema),
  blockers: boundary.optional(textArraySchema),
  nextAction: boundary.optional(textSchema),
  evidence: boundary.optional(linksSchema),
  outputs: boundary.optional(linksSchema),
});

const sessionUpdatePayloadSchema = boundary.object({
  name: boundary.optional(textSchema),
  archived: boundary.optional(boundary.boolean),
  isPinned: boundary.optional(boundary.boolean),
  agent: boundary.optional(agentSchema),
  launchCommand: boundary.optional(textSchema),
  profile: boundary.optional(textSchema),
  goal: boundary.optional(textSchema),
  context: boundary.optional(textSchema),
  decisions: boundary.optional(textArraySchema),
  blockers: boundary.optional(textArraySchema),
  nextAction: boundary.optional(textSchema),
  evidence: boundary.optional(linksSchema),
  outputs: boundary.optional(linksSchema),
  report: boundary.optional(boundary.nullable(reportSchema)),
  expectedRevision: boundary.optional(boundary.refine(
    boundary.number,
    value => Number.isInteger(value) && value >= 0,
    'expected a non-negative integer',
  )),
  source: boundary.optional(boundary.enumeration('user', 'agent')),
});

const SESSION_PAYLOAD_GUIDE = 'outputs and evidence items are {"label": string, '
  + '"url": https/http/file/grain URL, "addedAt": ISO 8601 date, "kind"?: evidence|output|ticket|pull-request|other, '
  + '"provenance"?: string}; decisions and blockers are arrays of strings; report is {"summary", '
  + '"status": reported|verified, "evidence": [at least one item], "reportedAt": ISO 8601 date, "provenance"}; '
  + 'arrays replace the stored value';

function decodeSessionPayload<Value>(value: JsonValue, schema: BoundarySchema<Value>, action: 'create' | 'update'): Value {
  try {
    return decodeBoundaryAll(value, schema);
  } catch (error) {
    if (!(error instanceof BoundaryDecodeIssues)) throw error;
    const count = error.issues.length === 1 ? '1 problem' : `${error.issues.length} problems`;
    throw new RunpaneError(
      'ERR_SESSION_PAYLOAD_INVALID',
      `The Session ${action} payload has ${count}: ${error.message}. Nothing was changed.`,
      `Fix every field listed and send the payload again: ${SESSION_PAYLOAD_GUIDE}. `
      + `Full shape and an example: runpane agent-context --command "sessions ${action}".`,
    );
  }
}

export type SessionCreatePayload = ReturnType<typeof sessionCreatePayloadSchema.decode>;
export type SessionUpdatePayload = ReturnType<typeof sessionUpdatePayloadSchema.decode>;

export function parseSessionCreatePayload(value: JsonValue): SessionCreatePayload {
  return decodeSessionPayload(value, sessionCreatePayloadSchema, 'create');
}

export function parseSessionUpdatePayload(value: JsonValue): SessionUpdatePayload {
  return decodeSessionPayload(value, sessionUpdatePayloadSchema, 'update');
}
