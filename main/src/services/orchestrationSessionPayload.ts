import { PaneError } from '../../../shared/paneError';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { OrchestrationLink, OrchestrationReport } from '../../../shared/types/orchestrationSession';
import {
  boundary,
  BoundaryDecodeIssues,
  decodeBoundaryAll,
  type BoundarySchema,
} from '../../../shared/validation/boundaryDecoder';

/**
 * The Session create/update payload pieces that people and agents write by hand. Decoded with
 * `decodeOrchestrationSessionPayload`, every problem is reported at once, and the link URL scheme
 * and dates are checked here first; the manager and store keep the same checks as backstops.
 * The CLI keeps the same rules in packages/runpane/src/localControl.ts.
 */
const LINK_URL_PATTERN = /^(?:https?:\/\/|file:\/\/|grain:\/\/)/i;

const isoDateSchema = boundary.refine(
  boundary.nonEmptyString,
  value => Number.isFinite(Date.parse(value)),
  'expected an ISO 8601 date such as 2026-10-14T09:30:00Z',
);

export const orchestrationTextSchema = boundary.string;
export const orchestrationTextArraySchema = boundary.array(orchestrationTextSchema);

export const orchestrationLinkSchema: BoundarySchema<OrchestrationLink> = boundary.object({
  label: boundary.nonEmptyString,
  url: boundary.refine(
    boundary.nonEmptyString,
    value => LINK_URL_PATTERN.test(value),
    'expected a URL starting with https://, http://, file:// or grain://',
  ),
  kind: boundary.optional(boundary.enumeration('evidence', 'output', 'ticket', 'pull-request', 'other')),
  provenance: boundary.optional(orchestrationTextSchema),
  addedAt: isoDateSchema,
});
export const orchestrationLinksSchema = boundary.array(orchestrationLinkSchema);

export const orchestrationReportSchema: BoundarySchema<OrchestrationReport> = boundary.object({
  summary: boundary.nonEmptyString,
  status: boundary.enumeration('reported', 'verified'),
  evidence: boundary.refine(orchestrationLinksSchema, links => links.length > 0, 'expected at least one link'),
  reportedAt: isoDateSchema,
  provenance: boundary.nonEmptyString,
});

export const orchestrationExpectedRevisionSchema = boundary.refine(
  boundary.number,
  value => Number.isInteger(value) && value >= 0,
  'expected a non-negative integer',
);

const ORCHESTRATION_SESSION_PAYLOAD_GUIDE = 'outputs and evidence items are {"label": string, '
  + '"url": https/http/file/grain URL, "addedAt": ISO 8601 date, "kind"?: evidence|output|ticket|pull-request|other, '
  + '"provenance"?: string}; decisions and blockers are arrays of strings; report is {"summary", '
  + '"status": reported|verified, "evidence": [at least one item], "reportedAt": ISO 8601 date, "provenance"}; '
  + 'arrays replace the stored value';

/** Decodes a Session create/update payload, reporting every problem in one PaneError. */
export function decodeOrchestrationSessionPayload<Value>(
  value: PaneCommandValue,
  schema: BoundarySchema<Value>,
  action: 'create' | 'update',
): Value {
  try {
    return decodeBoundaryAll(value, schema);
  } catch (error) {
    if (!(error instanceof BoundaryDecodeIssues)) throw error;
    const count = error.issues.length === 1 ? '1 problem' : `${error.issues.length} problems`;
    throw new PaneError(
      'ERR_SESSION_PAYLOAD_INVALID',
      `The Session ${action} payload has ${count}: ${error.message}. Nothing was changed.`,
      `Fix every field listed and send the payload again: ${ORCHESTRATION_SESSION_PAYLOAD_GUIDE}. `
      + `Full shape and an example: runpane agent-context --command "sessions ${action}".`,
    );
  }
}
