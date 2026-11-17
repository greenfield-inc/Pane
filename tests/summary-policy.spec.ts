import { test, expect } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NOTIFY_SUMMARY_CSP, type NotifyItem } from '../shared/types/notify';
import { summaryPage } from '../main/src/services/notify/summaryPage';

/**
 * An approval's Summary in a real HTML parser: the no-scripts policy must be the first element
 * of the real head, no script in the page may run, and nothing may load from the network,
 * whatever the page's markup or leading characters do.
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
const BEACON = '<img src="https://beacon.test/p.png">';
const PAGE = `<!doctype html><html><head>${RAN}</head><body>${BEACON}x</body></html>`;
const HOSTILE = {
  'commented-out head': `<!doctype html><!-- <head> --><html><head>${RAN}</head><body>${BEACON}x</body></html>`,
  'no head': `${RAN}${BEACON}<p>no head at all</p>`,
  'head inside a script string': `<script>var s = "<head>";</script>${RAN}${BEACON}<p>x</p>`,
  'head inside an attribute': `<html data-x="<head>"><body>${RAN}${BEACON}</body></html>`,
  'ordinary page': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>${RAN}</head><body>${BEACON}<img src=x onerror="document.documentElement.dataset.ran='yes'"></body></html>`,
  // Characters JavaScript counts as whitespace but the HTML parser reads as text.
  'leading no-break space': ` ${PAGE}`,
  'leading ideographic space': `　${PAGE}`,
  'leading line separator': ` ${PAGE}`,
  'leading vertical tab': `\u000B${PAGE}`,
  'byte order mark and whitespace': `﻿ \n\t${PAGE}`,
  'comment before the doctype': `<!-- x -->${PAGE}`,
  'text before the doctype': `x${PAGE}`,
} satisfies Record<string, string>;

const FRAME_SANDBOX = 'allow-same-origin'; // ApprovalColumn.tsx's Summary frame

for (const [name, source] of Object.entries(HOSTILE)) {
  test(`Summary policy holds for a page with a ${name}`, async ({ page }) => {
    const html = served(name.replace(/\W+/g, '-'), source);
    const requests: string[] = [];
    await page.route('https://beacon.test/**', (route) => {
      requests.push(route.request().url());
      return route.fulfill({ status: 200, body: '' });
    });

    // On its own: the policy is first in the real head and stops scripts by itself.
    await page.setContent(html);
    const first = await page.evaluate(() => {
      const meta = document.head.firstElementChild;
      return meta ? [meta.tagName, meta.getAttribute('http-equiv'), meta.getAttribute('content')] : null;
    });
    expect(first).toEqual(['META', 'Content-Security-Policy', NOTIFY_SUMMARY_CSP]);
    expect(await page.evaluate(() => document.documentElement.dataset.ran ?? 'no')).toBe('no');

    // In the production frame: the same, and nothing reaches the network.
    await page.setContent('<!doctype html><body></body>');
    const inFrame = await page.evaluate(async ({ srcdoc, sandbox }) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', sandbox);
      const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
      frame.srcdoc = srcdoc;
      document.body.append(frame);
      await loaded;
      await new Promise((resolve) => setTimeout(resolve, 200));
      const doc = frame.contentDocument;
      return doc?.head.firstElementChild?.getAttribute('http-equiv') ?? null;
    }, { srcdoc: html, sandbox: FRAME_SANDBOX });
    expect(inFrame).toBe('Content-Security-Policy');
    expect(requests).toEqual([]);
  });
}
