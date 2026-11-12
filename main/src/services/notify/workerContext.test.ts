import { describe, expect, it } from 'vitest';
import { statusCard, workerCard, workerReportCard } from './workerContext';

/**
 * Q-80's report, as the Session inbox holds it: the worker sent its whole status file as the
 * summary (indent 1), and the journal cut it to 2,000 characters with a marker, mid-JSON.
 */
const q80Status = {
  profile: 'greenfield/implementer',
  source: '.pane/prompts/2026-11-10T23-14-56-480Z-c24966.md',
  state: 'blocked',
  step: 'P-16 built (backend + web), unit tests green, make verify re-running; blocked on gcloud reauthentication before staging DDL group 5 and the staging features backfill',
  validation: 'full',
  needs_you: {
    id: 'Q-80',
    kind: 'approval',
    title: 'gcloud sign-in expired: needed to apply staging DDL group 5',
    questions: [{
      q: "Please run `! gauth-bloom` in this tab (it opens a browser) so I can apply the additive staging DDL (pricing_plan_features) and run the staging features backfill. Reply 'done' when signed in.",
      why: "gcloud says 'Reauthentication failed'; the staging DDL, the staging backfill dry run and every QA journey wait on it. The build itself isn't blocked.",
      options: ['Done, signed in (recommended)', 'Skip staging for now'],
    }],
    files: ['/work/custom-pricing-plans/.agent/plan/evidence/p16/wire-contract.md'],
    blocking: true,
  },
  assumptions: Array.from({ length: 12 }, (_, index) => `D-${110 + index}: an assumption the worker logged, long enough that the status file runs past the journal's cut, "quoted" too`),
  checks: { passed: ['unit'], failed: [], undetermined: [] },
};
const q80Summary = `${JSON.stringify(q80Status, null, 1).slice(0, 2_000)}\n[summary truncated]`;
const q80Title = "Q-80: gcloud sign-in expired. Please run '! gauth-bloom' in this tab so I can apply staging DDL group 5 and run the staging features backfill (the build itself continues).";

describe("a card built from a worker's status JSON", () => {
  it('reads Q-80: a truncated status file still gives its question, choices and files, never raw JSON', () => {
    expect(q80Summary.includes('"needs_you"') && !q80Summary.trimEnd().endsWith('}')).toBe(true);
    const card = statusCard(q80Summary, q80Title);
    expect(card).toEqual({
      context: `${q80Status.needs_you.questions[0].q}\n\n${q80Status.needs_you.questions[0].why}`,
      choices: [{ label: 'Done, signed in', recommended: true }, { label: 'Skip staging for now' }],
      links: [{ label: 'wire-contract.md', path: '/work/custom-pricing-plans/.agent/plan/evidence/p16/wire-contract.md' }],
    });
  });

  it('reads a bare needs_you block the same way, and leaves out a question the title already asks', () => {
    const needsYou = { id: 'Q-3', title: 'Invoice filename', questions: [{ q: 'Use the invoice id or number?', why: 'Ids are stable; numbers can be reissued.', options: ['Invoice id (recommended)', 'Invoice number'] }], files: ['/b/options.html#decision-2', 'https://example.com/spec'] };
    expect(statusCard(JSON.stringify(needsYou), 'Use the invoice id or number?')).toEqual({
      context: 'Ids are stable; numbers can be reissued.',
      choices: [{ label: 'Invoice id', recommended: true }, { label: 'Invoice number' }],
      links: [{ label: 'options.html', path: '/b/options.html#decision-2' }, { label: 'example.com/spec', url: 'https://example.com/spec' }],
    });
  });

  it('gives each of several questions its own buttons, with the top-level why as the subtitle', () => {
    const card = statusCard(JSON.stringify({ needs_you: { why: 'Invoices ship Friday.', questions: [{ q: 'Id or number?', options: ['Id (recommended)', 'Number'] }, { q: 'Keep old PDFs?', why: 'They are linked from emails.', options: ['Yes', 'No'] }] } }), 'Two invoice questions');
    expect(card).toEqual({
      context: 'Invoices ship Friday.',
      questions: [
        { title: 'Id or number?', choices: [{ label: 'Id', recommended: true }, { label: 'Number' }] },
        { title: 'Keep old PDFs?', why: 'They are linked from emails.', choices: [{ label: 'Yes' }, { label: 'No' }] },
      ],
    });
  });

  it('lists several questions in words when one of them has no options to press', () => {
    const card = statusCard(JSON.stringify({ needs_you: { questions: [{ q: 'Id or number?', options: ['Id', 'Number'] }, { q: 'Anything else?' }] } }), 'Two invoice questions');
    expect(card).toEqual({ context: '1. Id or number? (Id / Number)\n2. Anything else?' });
  });

  it('shows one plain line for JSON it does not recognize, even cut short, and never the raw text', () => {
    expect(statusCard(JSON.stringify({ state: 'blocked', step: 'Retry policy', checks: { passed: [] } }), 'T')).toEqual({ context: 'Retry policy' });
    expect(statusCard('{\n "state": "blocked",\n "title": "Invoice PDFs",\n "checks": {\n  "passed": [\n[summary truncated]', 'T')).toEqual({ context: 'Invoice PDFs' });
    expect(statusCard('{"checks": {"passed": []}}', 'T')).toEqual({});
    expect(statusCard('{ "checks": { "passed": [\n[summary truncated]', 'T')).toEqual({});
    expect(statusCard('{"state": "blocked", "checks": {', 'T')).toEqual({});
  });

  it('leaves prose alone, even when it starts with a bracket or brace', () => {
    expect(statusCard('Copied carts; the old table is still read.', 'T')).toBeUndefined();
    for (const prose of ['[WIP] Copied carts; the old table is still read.', '[PR #12](https://github.com/x/y/pull/12) is ready: merge it?', '{draft} Use ids', '{ not json at all', '[1/3] Step one'])
      expect(statusCard(prose, 'T'), prose).toBeUndefined();
    expect(workerReportCard('[WIP] Copied carts.', 'T')).toEqual({ context: '[WIP] Copied carts.' });
  });
});

describe("a worker card from its report summary", () => {
  it('keeps prose as written, and cuts a long one at a word with an ellipsis', () => {
    expect(workerReportCard('Copied carts.\n\nThe old table is still read by reports.', 'T')).toEqual({ context: 'Copied carts.\n\nThe old table is still read by reports.' });
    const long = workerReportCard('word '.repeat(600), 'T').context;
    expect(long?.endsWith('word…')).toBe(true);
    expect(long?.length).toBeLessThanOrEqual(2_001);
  });

  it('shows nothing for no summary, or a status file with no line for a person', () => {
    expect(workerReportCard('  ', 'T')).toEqual({});
    expect(workerReportCard(undefined, 'T')).toEqual({});
    expect(workerReportCard(JSON.stringify({ state: 'blocked', checks: { passed: [] }, needs_you: null }), 'T')).toEqual({});
  });
});

describe("a worker's card as runpane report posts it", () => {
  const status = JSON.stringify({ needs_you: { why: 'Approving needs this.', questions: [{ q: 'Ship tonight?', options: ['Ship (recommended)', 'Wait'] }] } });

  it('refuses a 200-character question and one with a line break, with a code and next step (J2)', () => {
    expect(() => workerCard(status, 'x'.repeat(200))).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_TITLE', next: expect.any(String) }));
    expect(() => workerCard(status, 'Ship it?\nCI is green.')).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_TITLE' }));
  });

  it('refuses a status-file question that recommends two options', () => {
    const two = JSON.stringify({ needs_you: { questions: [{ q: 'Ship?', options: ['Ship (recommended)', 'Wait (recommended)'] }] } });
    expect(() => workerCard(two, 'Ship the release?')).toThrow(expect.objectContaining({ code: 'ERR_NOTIFY_RECOMMENDED' }));
  });

  it('warns on a 120-character question with no subtitle, and posts it', () => {
    const card = workerCard(undefined, `${'word '.repeat(23)}ok?`);
    expect(card.warnings).toEqual([expect.stringMatching(/^The title is/u), expect.stringMatching(/^No subtitle/u)]);
  });

  it('keeps a card recorded before the check as it was sent when asked quietly', () => {
    expect(workerCard(status, 'x'.repeat(200), { quietly: true }).title).toBe('x'.repeat(200));
  });
});

describe("a worker's .html --summary-file", () => {
  it('is its Summary page, never its subtitle', () => {
    const card = workerCard('<!doctype html><html><body><h1>Q-80</h1></body></html>', 'Q-80: Sign in to gcloud?', { summaryPath: '/w/Q-80-summary.html' });
    expect(card.context).toBeUndefined();
  });
});
