import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import { boundary } from '../../../shared/validation/boundaryDecoder';
import {
  decodeOrchestrationSessionPayload,
  orchestrationLinkSchema,
  orchestrationReportSchema,
  orchestrationTextArraySchema,
} from './orchestrationSessionPayload';

const updateSchema = boundary.object({
  decisions: boundary.optional(orchestrationTextArraySchema),
  evidence: boundary.optional(boundary.array(orchestrationLinkSchema)),
  outputs: boundary.optional(boundary.array(orchestrationLinkSchema)),
  report: boundary.optional(boundary.nullable(orchestrationReportSchema)),
});

function failureOf(run: () => void): PaneError {
  try {
    run();
  } catch (error) {
    if (error instanceof PaneError) return error;
    throw error;
  }
  throw new Error('expected the payload to be rejected');
}

describe('decodeOrchestrationSessionPayload', () => {
  it('names every problem in one error, with the item shapes in next', () => {
    const error = failureOf(() => decodeOrchestrationSessionPayload({
      outputs: [{}],
      evidence: [{ label: 'x', url: 'ftp://x', addedAt: 'now' }],
      decisions: [1],
    }, updateSchema, 'update'));

    expect(error.code).toBe('ERR_SESSION_PAYLOAD_INVALID');
    expect(error.message).toBe(
      'The Session update payload has 6 problems: '
      + 'decisions[0]: expected string; '
      + 'evidence[0].url: expected a URL starting with https://, http://, file:// or grain://; '
      + 'evidence[0].addedAt: expected an ISO 8601 date such as 2026-10-14T09:30:00Z; '
      + 'outputs[0].label: missing; outputs[0].url: missing; outputs[0].addedAt: missing. '
      + 'Nothing was changed.',
    );
    expect(error.next).toContain('{"label": string, "url": https/http/file/grain URL, "addedAt": ISO 8601 date');
    expect(error.next).toContain('runpane agent-context --command "sessions update"');
  });

  it('checks the report shape, its evidence count and its date', () => {
    const error = failureOf(() => decodeOrchestrationSessionPayload({
      report: { summary: 'done', status: 'reported', evidence: [], reportedAt: 'yesterday' },
    }, updateSchema, 'update'));
    expect(error.message).toContain('report.evidence: expected at least one link');
    expect(error.message).toContain('report.reportedAt: expected an ISO 8601 date');
    expect(error.message).toContain('report.provenance: missing');
  });

  it('accepts a well-formed payload unchanged', () => {
    const payload = {
      decisions: ['Ship it'],
      outputs: [{ label: 'PR', url: 'https://github.com/o/r/pull/1', addedAt: '2026-10-14T09:30:00Z', kind: 'pull-request', provenance: 'agent' }],
      evidence: [{ label: 'Log', url: 'file:///tmp/log.txt', addedAt: '2026-10-14' }],
      report: {
        summary: 'Done',
        status: 'verified',
        evidence: [{ label: 'Page', url: 'grain://page', addedAt: '2026-10-14T09:30:00.000Z' }],
        reportedAt: '2026-10-14T09:31:00Z',
        provenance: 'qa agent',
      },
    };
    expect(decodeOrchestrationSessionPayload(payload, updateSchema, 'update')).toEqual(payload);
  });
});
