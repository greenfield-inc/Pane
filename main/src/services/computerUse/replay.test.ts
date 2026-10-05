import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveStep, writeReplay } from './replay';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The step data the page renders from. */
function stepsIn(html: string): Array<{ run: string; action: string; image: string | null; result: unknown }> {
  const match = /<script id="steps" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error('no steps in page');
  return JSON.parse(match[1]);
}

describe('replay', () => {
  it('writes one page listing every step of every run, in order, with screenshots beside it', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
    const png = { mime: 'image/png', base64: PNG_BYTES.toString('base64') };
    const jpeg = { mime: 'image/jpeg', base64: JPEG_BYTES.toString('base64') };
    await saveStep(dir, 'run-a', { index: 0, action: 'click', args: { element: 3 }, result: 'clicked', screenshot: png, at: '2026-10-04T23:00:00Z' });
    await saveStep(dir, 'run-a', { index: 1, action: 'type_text', args: { text: 'hi' }, result: 'typed', at: '2026-10-04T23:00:01Z' });
    await saveStep(dir, 'run-b', { index: 2, action: 'press_key', args: { key: 'Return' }, result: 'pressed', screenshot: jpeg, at: '2026-10-04T23:01:00Z' });

    const page = fs.readFileSync(await writeReplay(dir), 'utf8');

    expect(stepsIn(page).map(({ run, action, image }) => ({ run, action, image }))).toEqual([
      { run: 'run-a', action: 'click', image: 'steps/run-a-0000.png' },
      { run: 'run-a', action: 'type_text', image: null },
      { run: 'run-b', action: 'press_key', image: 'steps/run-b-0002.jpg' },
    ]);
    expect(fs.readFileSync(path.join(dir, 'steps', 'run-a-0000.png'))).toEqual(PNG_BYTES);
    expect(fs.readFileSync(path.join(dir, 'steps', 'run-b-0002.jpg'))).toEqual(JPEG_BYTES);
    // No network: the policy allows only inline code and local images.
    expect(page).toContain(`content="default-src 'none'; img-src file:;`);
  });

  it('keeps step text from closing the data script', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
    await saveStep(dir, 'run', { index: 0, action: 'type_text', args: {}, result: '</script><script>alert(1)</script>', at: '2026-10-04T23:00:00Z' });

    const page = fs.readFileSync(await writeReplay(dir), 'utf8');

    expect(stepsIn(page)[0]?.result).toBe('</script><script>alert(1)</script>');
  });
});
