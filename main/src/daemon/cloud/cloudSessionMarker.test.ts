import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { whenCloudSession } from './cloudSessionMarker';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('whenCloudSession', () => {
  let dir: string;
  let marker: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-marker-'));
    marker = path.join(dir, 'serve.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs at once when the marker exists', () => {
    fs.writeFileSync(marker, '{}');
    let calls = 0;
    whenCloudSession(() => calls++, { path: marker, pollMs: 10, bootstrapStateDir: path.join(dir, 'none') });
    expect(calls).toBe(1);
  });

  it('runs once when the bootstrap writes the marker later', async () => {
    let calls = 0;
    const stop = whenCloudSession(() => calls++, { path: marker, pollMs: 10, bootstrapStateDir: dir });
    await wait(40);
    expect(calls).toBe(0);
    fs.writeFileSync(marker, '{}');
    await wait(60);
    expect(calls).toBe(1);
    stop();
  });

  it('stops looking after the wait (not a Session)', async () => {
    let calls = 0;
    whenCloudSession(() => calls++, { path: marker, pollMs: 10, waitMs: 30, bootstrapStateDir: dir });
    await wait(60);
    fs.writeFileSync(marker, '{}');
    await wait(40);
    expect(calls).toBe(0);
  });

  // Desktop and self-hosted daemons have no Session bootstrap behind them: nothing to wait for.
  it('does not poll when no Session bootstrap is in progress', async () => {
    let calls = 0;
    const stop = whenCloudSession(() => calls++, { path: marker, pollMs: 10, bootstrapStateDir: path.join(dir, 'none') });
    fs.writeFileSync(marker, '{}');
    await wait(50);
    expect(calls).toBe(0);
    stop();
  });
});
