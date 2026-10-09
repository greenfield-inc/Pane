import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { streamMediaFile } from './mediaStream';

let directory: string;
let filePath: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-media-'));
  filePath = path.join(directory, 'clip.mp4');
  await fs.writeFile(filePath, '0123456789');
});
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

it('streams a seek range with the byte offsets and total size Chromium needs', async () => {
  const response = await streamMediaFile(filePath, new Request('https://preview', { headers: { Range: 'bytes=2-5' } }));
  expect(response.status).toBe(206);
  expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
  expect(response.headers.get('Content-Length')).toBe('4');
  expect(response.headers.get('Content-Type')).toBe('video/mp4');
  expect(await response.text()).toBe('2345');
});

it.each([
  ['bytes=6-', '6789', 'bytes 6-9/10'],
  ['bytes=-3', '789', 'bytes 7-9/10'],
  ['bytes=8-1000', '89', 'bytes 8-9/10'],
])('supports %s', async (range, body, expectedRange) => {
  const response = await streamMediaFile(filePath, new Request('https://preview', { headers: { Range: range } }));
  expect(response.status).toBe(206);
  expect(response.headers.get('Content-Range')).toBe(expectedRange);
  expect(await response.text()).toBe(body);
});

it.each(['bytes=10-', 'bytes=3-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'bytes=abc'])('rejects an unsatisfiable range %s', async range => {
  const response = await streamMediaFile(filePath, new Request('https://preview', { headers: { Range: range } }));
  expect(response.status).toBe(416);
  expect(response.headers.get('Content-Range')).toBe('bytes */10');
});

it('serves metadata without a body and supports empty media', async () => {
  const head = await streamMediaFile(filePath, new Request('https://preview', { method: 'HEAD' }));
  expect(head.headers.get('Content-Length')).toBe('10');
  expect(await head.text()).toBe('');
  await fs.truncate(filePath, 0);
  const empty = await streamMediaFile(filePath, new Request('https://preview'));
  expect(empty.status).toBe(200);
  expect(await empty.text()).toBe('');
});

it('reads a small range from an 8 GiB file without buffering the file', async () => {
  const size = 8 * 1024 ** 3;
  await fs.truncate(filePath, size);
  const response = await streamMediaFile(filePath, new Request('https://preview', { headers: { Range: `bytes=${size - 4}-` } }));
  expect(response.headers.get('Content-Range')).toBe(`bytes ${size - 4}-${size - 1}/${size}`);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(4));
});

it('allows the reader to cancel a full-file stream', async () => {
  const response = await streamMediaFile(filePath, new Request('https://preview'));
  expect(response.status).toBe(200);
  await response.body?.cancel();
});

it.each([['.svg', 'image/svg+xml'], ['.avif', 'image/avif'], ['.pdf', 'application/pdf'], ['.woff2', 'font/woff2']])('streams %s with its native MIME type and fetch headers', async (extension, mime) => {
  const pathWithType = path.join(directory, `preview${extension}`);
  await fs.writeFile(pathWithType, '0123456789');
  const response = await streamMediaFile(pathWithType, new Request('https://preview', { headers: { Range: 'bytes=0-3' } }));
  expect(response.status).toBe(206);
  expect(response.headers.get('Content-Type')).toBe(mime);
  expect(response.headers.get('Access-Control-Expose-Headers')).toContain('Content-Range');
  expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  expect(await response.text()).toBe('0123');
});
