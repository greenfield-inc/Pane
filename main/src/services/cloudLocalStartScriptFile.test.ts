import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createCloudLocalStartScriptFile } from './cloudLocalStartScriptFile';

describe('createCloudLocalStartScriptFile', () => {
  it('keeps the script and its shell beside startup.sh, private to the user', async () => {
    const paneDir = mkdtempSync(join(tmpdir(), 'pane-local-start-'));
    const file = createCloudLocalStartScriptFile('powershell', paneDir);

    await expect(file.read()).resolves.toEqual({ shell: 'powershell', script: '' });
    await file.write({ shell: 'cmd', script: 'echo DOPPLER_TOKEN=x' });

    const saved = join(paneDir, 'cloud-sandboxes', 'local-start.json');
    expect(JSON.parse(readFileSync(saved, 'utf8'))).toEqual({ shell: 'cmd', script: 'echo DOPPLER_TOKEN=x' });
    if (process.platform !== 'win32') expect(statSync(saved).mode & 0o777).toBe(0o600);
    await expect(file.read()).resolves.toEqual({ shell: 'cmd', script: 'echo DOPPLER_TOKEN=x' });

    writeFileSync(saved, '{ "shell": "bash", "script": "" }');
    await expect(file.read()).rejects.toThrow('is not a saved local start script');
  });
});
