import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { trustClaudeFolder } from './claudeFolderTrust';

function configIn(contents?: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-trust-'));
  const file = path.join(dir, '.claude.json');
  if (contents !== undefined) writeFileSync(file, contents, { mode: 0o600 });
  return file;
}

describe('trustClaudeFolder', () => {
  it('marks only that folder trusted and keeps everything else in the config', async () => {
    const file = configIn(JSON.stringify({
      userID: 'u1',
      projects: { '/repos/app': { hasTrustDialogAccepted: false }, '/pane/sessions/s1': { lastCost: 0.25 } },
    }));
    await expect(trustClaudeFolder('/pane/sessions/s1', file)).resolves.toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      userID: 'u1',
      projects: { '/repos/app': { hasTrustDialogAccepted: false }, '/pane/sessions/s1': { lastCost: 0.25, hasTrustDialogAccepted: true } },
    });
    // Windows reports no Unix permission bits.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(trustClaudeFolder('/pane/sessions/s1', file)).resolves.toBe(false);
  });

  it('starts a missing config, and leaves one it cannot read untouched', async () => {
    const missing = configIn();
    await trustClaudeFolder('/pane/sessions/s2', missing);
    expect(JSON.parse(readFileSync(missing, 'utf8'))).toEqual({ projects: { '/pane/sessions/s2': { hasTrustDialogAccepted: true } } });

    const broken = configIn('{ not json');
    await expect(trustClaudeFolder('/pane/sessions/s3', broken)).rejects.toThrow();
    expect(readFileSync(broken, 'utf8')).toBe('{ not json');
    const odd = configIn('{"projects":["not an object"]}');
    await expect(trustClaudeFolder('/pane/sessions/s4', odd)).rejects.toThrow();
    expect(readFileSync(odd, 'utf8')).toBe('{"projects":["not an object"]}');
  });
});
