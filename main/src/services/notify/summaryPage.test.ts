import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NOTIFY_SUMMARY_CSP, type NotifyItem } from '../../../../shared/types/notify';
import { summaryPage } from './summaryPage';
import { summaryFiles } from './notifyService';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-summary-'));
const statusFile = path.join(dir, 'status.json');
fs.writeFileSync(statusFile, JSON.stringify({ state: 'blocked', step: 'P-16 built, make verify re-running', checks: { passed: ['unit', 'lint'], failed: [], undetermined: ['staging QA'] } }));

const q80: NotifyItem = {
  id: 'q80', ui: 'options', state: 'waiting', createdAt: Date.UTC(2026, 10, 11, 15, 15),
  title: 'Q-80: Sign in to gcloud so staging can continue',
  context: 'gcloud’s sign-in expired; the staging schema change and every QA journey wait on it.',
  choices: [{ label: 'Done, signed in', detail: 'Applies the staging schema, then QA on staging.', recommended: true }, { label: 'Skip staging for now' }],
  links: [{ label: 'wire-contract.md', path: '/work/p16/wire-contract.md' }, { label: 'PR #1359', url: 'https://github.com/o/r/pull/1359' }],
  source: { name: 'custom-pricing-plans', agent: 'Claude', session: { id: 's', name: 'Subscriptions', paneId: 'p' } },
  statusFile,
};

describe("an approval's Summary page", () => {
  it("is Pane's template when no page was sent: subtitle first, each option and its consequence, where it stands, references with real paths", () => {
    const page = summaryPage(q80);
    expect(page.kind).toBe('template');
    const html = page.kind === 'template' ? page.html : '';
    const text = html.replace(/<style>[\s\S]*?<\/style>/u, '').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ');
    expect(text).toContain('Q-80: Sign in to gcloud so staging can continue');
    expect(text.indexOf('gcloud’s sign-in expired')).toBeLessThan(text.indexOf('Done, signed in'));
    expect(text).toContain('Applies the staging schema, then QA on staging.');
    expect(text).toContain('Skip staging for now No consequence was sent.');
    expect(text).toContain('Where it stands. P-16 built, make verify re-running. Checks: 2 passed, 1 undetermined.');
    expect(text).toContain('wire-contract.md : /work/p16/wire-contract.md');
    expect(text).toContain('worker’s status file');
    expect(html).toContain(`content="${NOTIFY_SUMMARY_CSP}"`);
    expect(html).not.toMatch(/<script/iu);
  });

  it("is the asker's own page, served with the no-scripts, no-network policy ahead of everything in it", () => {
    const file = path.join(dir, 'Q-80-summary.html');
    fs.writeFileSync(file, '<!doctype html><html><head><title>Q-80</title><script>alert(1)</script></head><body><h1>Q-80</h1></body></html>');
    const page = summaryPage({ ...q80, summaryPage: file });
    expect(page).toMatchObject({ kind: 'page', path: file });
    const html = page.kind === 'page' ? page.html : '';
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
  });

  it("falls back to the template, saying so, when the asker's page is gone", () => {
    const page = summaryPage({ ...q80, summaryPage: path.join(dir, 'removed.html') });
    expect(page.kind).toBe('template');
    expect(page.kind === 'template' && page.html).toContain('wasn’t found at');
  });

  it("takes a worker's .html --summary-file as its page, and any other file as its status file", () => {
    expect(summaryFiles('/w/Q-80-summary.html', undefined)).toEqual({ summaryPage: '/w/Q-80-summary.html' });
    expect(summaryFiles('/w/status.json', 'pages/summary.html')).toEqual({ statusFile: '/w/status.json', summaryPage: path.resolve('/w/pages/summary.html') });
    // Written from the worker's folder (the worktree), with the status file in tmp/: found one folder up.
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'tmp', 'summary.html'), '<p>Q-80</p>');
    expect(summaryFiles(path.join(dir, 'tmp', 'status.json'), 'tmp/summary.html').summaryPage).toBe(path.join(dir, 'tmp', 'summary.html'));
    expect(summaryFiles('/w/tmp/status.json', 'tmp/missing.html').summaryPage).toBe(path.resolve('/w/tmp/missing.html'));
    expect(summaryFiles(undefined, undefined)).toEqual({});
  });
});
