import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { dismissRecovery, pendingRecoveries, recoveryFolder, writeRecoveryNote } from './agentFarmRecovery';

/** The Profiles tab's one-time notice for a plugin Pane saved aside (#1740 review F-3). */

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'pane-af-recovery-'));
  temporary.push(root);
  return root;
}

async function recovery(root: string, id: string, plugin = 'greenfield'): Promise<string> {
  const folder = path.join(root, 'recovered', id);
  mkdirSync(path.join(folder, 'plugin'), { recursive: true });
  writeFileSync(path.join(folder, 'plugin', 'plugin.yaml'), 'name: mine\n');
  await writeRecoveryNote(folder, { plugin, version: '0.0.9', reason: 'unknown variant opus' });
  return folder;
}

describe('the saved-aside plugin notice', () => {
  it('lists each recovery until it is dismissed, then never again, keeping its files', async () => {
    const root = configRoot();
    const first = await recovery(root, 'greenfield-0.0.9-2026-11-26T10-00-00-000Z');
    const second = await recovery(root, 'greenfield-0.0.9-2026-11-27T10-00-00-000Z');
    expect(await pendingRecoveries(root)).toEqual([
      { id: 'greenfield-0.0.9-2026-11-26T10-00-00-000Z', plugin: 'greenfield', folder: first },
      { id: 'greenfield-0.0.9-2026-11-27T10-00-00-000Z', plugin: 'greenfield', folder: second },
    ]);
    await dismissRecovery(root, 'greenfield-0.0.9-2026-11-26T10-00-00-000Z');
    // Read fresh, as a restart would: the dismissed one stays gone, the other still shows.
    expect((await pendingRecoveries(root)).map(entry => entry.folder)).toEqual([second]);
    await dismissRecovery(root, 'greenfield-0.0.9-2026-11-26T10-00-00-000Z');
    expect(readFileSync(path.join(first, 'plugin', 'plugin.yaml'), 'utf8')).toBe('name: mine\n');
  });

  it('lists nothing without a recovered folder, and skips one with no readable note', async () => {
    const root = configRoot();
    expect(await pendingRecoveries(root)).toEqual([]);
    mkdirSync(path.join(root, 'recovered', 'by-hand'), { recursive: true });
    mkdirSync(path.join(root, 'recovered', 'garbled'), { recursive: true });
    writeFileSync(path.join(root, 'recovered', 'garbled', 'recovery.json'), '{not json');
    expect(await pendingRecoveries(root)).toEqual([]);
  });

  it('opens and dismisses only a recovery folder by its own name', async () => {
    const root = configRoot();
    const folder = await recovery(root, 'greenfield-0.0.9-2026-11-27T10-00-00-000Z');
    expect(await recoveryFolder(root, 'greenfield-0.0.9-2026-11-27T10-00-00-000Z')).toBe(folder);
    for (const id of ['', '.', '..', '../plugins', 'a/b', 'a\\b', 'missing']) {
      await expect(recoveryFolder(root, id), id).rejects.toThrow('Pane has no saved copy');
      await expect(dismissRecovery(root, id), id).rejects.toThrow('Pane has no saved copy');
    }
  });
});
