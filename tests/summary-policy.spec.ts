import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NOTIFY_SUMMARY_CSP, type NotifyItem } from '../shared/types/notify';
import { summaryPage } from '../main/src/services/notify/summaryPage';

/**
 * An approval's Summary in a real HTML parser: the no-scripts policy must be the first element
 * of the real head, and no script in the page may run, whatever the page's markup does.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-summary-policy-'));
const item: NotifyItem = {
  id: 'q1', ui: 'options', state: 'waiting', createdAt: 0, title: 'Q-1: Summary policy',
  source: { name: 'worker', agent: 'Claude' },
};

function served(name: string, source: string): string {
  const file = path.join(dir, `${name}.html`);
  fs.writeFileSync(file, source);
  const page = summaryPage({ ...item, summaryPage: file });
  if (page.kind !== 'page') throw new Error(`expected the asker's page, got ${page.kind}`);
  return page.html;
}

const RAN = '<script>document.documentElement.dataset.ran = "yes"</script>';
const HOSTILE = {
  'commented-out head': `<!doctype html><!-- <head> --><html><head>${RAN}</head><body>x</body></html>`,
  'no head': `${RAN}<p>no head at all</p>`,
  'head inside a script string': `<script>var s = "<head>";</script>${RAN}<p>x</p>`,
  'head inside an attribute': `<html data-x="<head>"><body>${RAN}</body></html>`,
  'ordinary page': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>${RAN}</head><body><img src=x onerror="document.documentElement.dataset.ran='yes'"></body></html>`,
} satisfies Record<string, string>;

for (const [name, source] of Object.entries(HOSTILE)) {
  test(`Summary policy holds for a page with a ${name}`, async ({ page }) => {
    await page.setContent(served(name.replace(/\W+/g, '-'), source));
    const first = await page.evaluate(() => {
      const meta = document.head.firstElementChild;
      return meta ? [meta.tagName, meta.getAttribute('http-equiv'), meta.getAttribute('content')] : null;
    });
    expect(first).toEqual(['META', 'Content-Security-Policy', NOTIFY_SUMMARY_CSP]);
    expect(await page.evaluate(() => document.documentElement.dataset.ran ?? 'no')).toBe('no');
  });
}
