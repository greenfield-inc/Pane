import { expect, test } from '@playwright/test';
import { openConnectedRemotePwa } from './remotePwaMock';

// The phone's Explorer tab browses the selected pane's worktree through the
// host's file commands, edits text files in place, and previews media from the
// host's phone files address.

const FILES_URL = 'http://phone-pages.test:44300';
const PORTS = { host: 'MacBook Pro', ports: [], phone: { state: 'on', filesUrl: FILES_URL } } as const;

// A 1x1 PNG, so the preview has real image bytes to decode.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test('a phone edits a worktree file and saves it to the host', async ({ page }) => {
  const host = await openConnectedRemotePwa(page, {
    ports: PORTS,
    files: { 'README.md': '# Demo\n', 'src/app.css': 'body { color: red; }\n' },
  });

  await page.getByRole('tab', { name: 'Explorer' }).click();
  await expect(page.getByRole('button', { name: 'README.md' })).toBeVisible();
  await page.getByRole('button', { name: 'src' }).click();
  await page.getByRole('button', { name: 'app.css' }).click();

  const editor = page.getByRole('textbox', { name: 'src/app.css' });
  await expect(editor).toHaveValue('body { color: red; }\n');
  await editor.fill('body { color: blue; }\n');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => host.files['src/app.css']).toBe('body { color: blue; }\n');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  await page.getByRole('button', { name: 'Back to files' }).click();
  await expect(page.getByRole('button', { name: 'app.css' })).toBeVisible();
});

test('saving keeps a file\'s Windows line endings', async ({ page }) => {
  const host = await openConnectedRemotePwa(page, { ports: PORTS, files: { 'notes.txt': 'one\r\ntwo\r\n' } });

  await page.getByRole('tab', { name: 'Explorer' }).click();
  await page.getByRole('button', { name: 'notes.txt' }).click();
  await page.getByRole('textbox', { name: 'notes.txt' }).fill('one\ntwo\nthree\n');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => host.files['notes.txt']).toBe('one\r\ntwo\r\nthree\r\n');
});

test('a phone previews worktree media from the host\'s files address', async ({ page }) => {
  await page.route(`${FILES_URL}/**/*.png`, route => route.fulfill({ contentType: 'image/png', body: PNG }));
  // Held open: an answer that is not a real video would swap the player for the "did not load" notice.
  await page.route(`${FILES_URL}/**/*.mp4`, () => {});
  await openConnectedRemotePwa(page, {
    ports: PORTS,
    files: { 'docs/shot one.png': null, 'docs/demo.mp4': null },
  });

  await page.getByRole('tab', { name: 'Explorer' }).click();
  await page.getByRole('button', { name: 'docs' }).click();

  await page.getByRole('button', { name: 'shot one.png' }).click();
  const image = page.getByRole('img', { name: 'docs/shot one.png' });
  await expect(image).toHaveAttribute('src', `${FILES_URL}/media/anim-remote-0/docs/shot%20one.png`);
  // SAFETY: the locator matched an <img> by its role.
  await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);

  await page.getByRole('button', { name: 'Back to files' }).click();
  await page.getByRole('button', { name: 'demo.mp4' }).click();
  await expect(page.locator('video')).toHaveAttribute('src', `${FILES_URL}/media/anim-remote-0/docs/demo.mp4`);
});
