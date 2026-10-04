import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createCloudStartupScriptFile } from './cloudStartupScriptFile';

describe('createCloudStartupScriptFile', () => {
  it('keeps the script in <pane data dir>/cloud-sandboxes/startup.sh, private to the user', async () => {
    const paneDir = mkdtempSync(join(tmpdir(), 'pane-startup-'));
    const file = createCloudStartupScriptFile(paneDir);

    await expect(file.read()).resolves.toBe('');
    await file.write('command -v doppler || echo install\n');

    const scriptPath = join(paneDir, 'cloud-sandboxes', 'startup.sh');
    expect(readFileSync(scriptPath, 'utf8')).toBe('command -v doppler || echo install\n');
    if (process.platform !== 'win32') {
      expect(statSync(scriptPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(paneDir, 'cloud-sandboxes')).mode & 0o777).toBe(0o700);
    }
    await expect(file.read()).resolves.toBe('command -v doppler || echo install\n');

    await file.write('');
    await expect(file.read()).resolves.toBe('');
  });
});
