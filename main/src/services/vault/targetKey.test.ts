import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { loadOrCreateTargetKey, targetKeyPath } from './targetKey';

const dirs: string[] = [];

async function tempPaneDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-vault-key-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('loadOrCreateTargetKey', () => {
  it('creates one key per machine, readable only by its owner, and keeps it', async () => {
    const paneDir = await tempPaneDir();
    const [first, concurrent] = await Promise.all([loadOrCreateTargetKey(paneDir), loadOrCreateTargetKey(paneDir)]);
    const later = await loadOrCreateTargetKey(paneDir);

    expect(Buffer.from(first.publicKey, 'base64url')).toHaveLength(32);
    expect(concurrent).toEqual(first);
    expect(later).toEqual(first);
    if (process.platform !== 'win32') {
      expect((await fs.stat(targetKeyPath(paneDir))).mode & 0o777).toBe(0o600);
    }
  });
});
