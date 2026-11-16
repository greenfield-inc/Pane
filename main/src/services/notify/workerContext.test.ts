import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { journalAgentReport, normalizeAgentReport } from '../agentReport';
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
    expect(card).toMatchObject({
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

describe("a worker's status file longer than the journal keeps", () => {
  it('gets its buttons, links and Summary page from the file itself', () => {
    const why = (topic: string) => `${topic} decides what ships in the first kit release, and the screens built after it inherit the choice, so changing it later means touching every one of them again. The options page shows each choice on the real screens, light and dark, at phone and desktop width.`;
    const status = {
      profile: 'greenfield/implementer',
      state: 'blocked',
      step: 'UI kit tokens and primitives built; blocked on four product calls before the screens',
      needs_you: {
        id: 'Q-7',
        kind: 'choice',
        title: 'Four UI kit calls before the screens',
        why: 'The screens are built on these four choices.',
        questions: [
          { q: 'Which type scale?', why: why('The type scale'), options: ['Major third (recommended)', 'Perfect fourth', 'Golden ratio'] },
          { q: 'Which corner radius?', why: why('The corner radius'), options: ['8 px (recommended)', '4 px', '12 px'] },
          { q: 'Which icon set?', why: why('The icon set'), options: ['Lucide (recommended)', 'Phosphor'] },
          { q: 'Dark mode in the first release?', why: why('Dark mode'), options: ['Yes (recommended)', 'Later'] },
        ],
        files: ['/work/glassly/bundle/options.html#decision-1', '/work/glassly/bundle/index.html', '/work/glassly/bundle/cover-sheet.html'],
        summary: 'options.html',
        blocking: true,
        answers: [],
      },
      assumptions: Array.from({ length: 8 }, (_, index) => `A-${index + 1}: an assumption the worker logged while building the kit, long enough to matter`),
    };
    const statusPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-status-')), 'ui-kit.json');
    fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
    const full = fs.readFileSync(statusPath, 'utf8');
    const journaled = journalAgentReport(normalizeAgentReport({ state: 'blocked', question: 'Q-7: Four UI kit calls before the screens', summary: full, summaryPath: statusPath }, '2026-11-16T09:00:00.000Z'));
    expect(full.indexOf('"files"')).toBeGreaterThan(2_000);

    const card = workerCard(journaled.summary, 'Q-7: Four UI kit calls before the screens', { quietly: true, summaryPath: statusPath, readStatusFile: journaled.summaryTruncated });

    expect(card.questions?.map(question => [question.title, question.choices.map(choice => choice.label)])).toEqual([
      ['Which type scale?', ['Major third', 'Perfect fourth', 'Golden ratio']],
      ['Which corner radius?', ['8 px', '4 px', '12 px']],
      ['Which icon set?', ['Lucide', 'Phosphor']],
      ['Dark mode in the first release?', ['Yes', 'Later']],
    ]);
    expect(card.links).toEqual([
      { label: 'options.html', path: '/work/glassly/bundle/options.html#decision-1' },
      { label: 'index.html', path: '/work/glassly/bundle/index.html' },
      { label: 'cover-sheet.html', path: '/work/glassly/bundle/cover-sheet.html' },
    ]);
    expect(card.summaryPage).toBe('options.html');
  });

  const cutReport = (summaryPath: string) => journalAgentReport(normalizeAgentReport({ state: 'blocked', question: 'Q-8: Pick one', summary: `{"step": "Waiting on Q-8", "log": "${'s'.repeat(2_100)}"}`, summaryPath }, '2026-11-16T09:00:00.000Z'));
  const tempPath = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-status-')), name);

  it('keeps the cut summary when the file is prose or a pipe, and never waits on the pipe', () => {
    const prose = tempPath('notes.txt');
    fs.writeFileSync(prose, 'Private notes that are not a status file.');
    const fifo = tempPath('status.fifo');
    execFileSync('mkfifo', [fifo]);
    for (const summaryPath of [prose, fifo]) {
      const card = workerCard(cutReport(summaryPath).summary, 'Q-8: Pick one', { quietly: true, summaryPath, readStatusFile: true });
      expect(card.context).toBe('Waiting on Q-8');
    }
  });

  it('tells the worker when needs_you sits past the first 256 KB', () => {
    const big = tempPath('status.json');
    fs.writeFileSync(big, JSON.stringify({ step: 'Late step', log: 'x'.repeat(300 * 1024), needs_you: { questions: [{ q: 'Ship?', options: ['Ship (recommended)', 'Wait'] }] } }));
    const card = workerCard(cutReport(big).summary, 'Q-8: Pick one', { quietly: true, summaryPath: big, readStatusFile: true });
    expect(card.choices).toBeUndefined();
    expect(card.warnings).toEqual([expect.stringContaining('over 256 KB')]);
  });

  it('shows the status link and the first files, and names the files it has no room for', () => {
    const many = tempPath('status.json');
    const files = Array.from({ length: 8 }, (_, index) => `/w/page-${index + 1}.html`);
    fs.writeFileSync(many, JSON.stringify({ step: 's'.repeat(2_100), needs_you: { why: 'Eight pages to read.', questions: [{ q: 'Ship?', options: ['Ship (recommended)', 'Wait'] }], files } }));
    const card = workerCard(cutReport(many).summary, 'Q-8: Pick one', { quietly: true, summaryPath: many, readStatusFile: true, statusLabel: 'kit status' });
    expect(card.links?.map(link => link.label)).toEqual(['kit status', 'page-1.html', 'page-2.html', 'page-3.html', 'page-4.html', 'page-5.html']);
    expect(card.context).toContain('More links: page-6.html, page-7.html, page-8.html');
  });
});
