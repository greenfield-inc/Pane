import { describe, expect, it } from 'vitest';
import { workerReportContext } from './workerContext';

describe("a worker card's context", () => {
  it('reads a status file as one human line: the question\'s why, else the summary or step', () => {
    const status = { profile: 'greenfield/implementer', state: 'blocked', step: 'Retry policy', needs_you: { questions: [{ q: 'Id or number?', why: 'Ids are stable.' }] }, checks: { passed: ['unit'] } };
    expect(workerReportContext(JSON.stringify(status, null, 2))).toBe('Ids are stable.');
    expect(workerReportContext(JSON.stringify({ state: 'blocked', summary: 'PDFs render.', step: 'Retry policy', needs_you: null }))).toBe('PDFs render.');
    expect(workerReportContext(JSON.stringify({ state: 'blocked', step: 'Retry policy' }))).toBe('Retry policy');
  });

  it('shows nothing for a status file with no line for a person', () => {
    expect(workerReportContext(JSON.stringify({ state: 'blocked', checks: { passed: [] } }))).toBeUndefined();
    expect(workerReportContext('[1, 2]')).toBeUndefined();
    expect(workerReportContext('  ')).toBeUndefined();
  });

  it('keeps prose as written, and cuts a long one at a word with an ellipsis', () => {
    expect(workerReportContext('Copied carts.\n\nThe old table is still read by reports.')).toBe('Copied carts.\n\nThe old table is still read by reports.');
    const long = workerReportContext('word '.repeat(600));
    expect(long?.endsWith('word…')).toBe(true);
    expect(long?.length).toBeLessThanOrEqual(2_001);
  });
});
