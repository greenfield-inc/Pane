import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentFarmConfigRoot, bundledAgentFarm, installBundledAgentFarm, installedState } from './bundledAgentFarm';
import { ProfileEditor } from './profileEditor';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the Profiles poll and Edited (review F-8)', () => {
  it('hashes a bundled plugin again only when one of its files changed', async () => {
    const paneDir = mkdtempSync(path.join(tmpdir(), 'pane-profiles-cache-'));
    temporary.push(paneDir);
    const bundle = bundledAgentFarm();
    if (!bundle) throw new Error('Expected the pinned @greenfieldco/agent-farm package');
    expect((await installBundledAgentFarm({ paneDir, bundle, log: () => undefined })).state).toBe('ready');
    // Agent Farm's real check, counted: each call reads and hashes every file of the plugin.
    let sweeps = 0;
    const counted: typeof installedState = (...args) => { sweeps += 1; return installedState(...args); };
    const profiles = new ProfileEditor({ paneDir, machine: () => 'studio-mac', bundle, installedState: counted });
    const edited = async () => (await profiles.list()).plugins.find(plugin => plugin.name === 'greenfield')?.edited;
    expect(await edited()).toBe(false);
    sweeps = 0;
    await profiles.list();
    await profiles.list();
    expect(sweeps).toBe(0);
    writeFileSync(path.join(agentFarmConfigRoot(paneDir), 'plugins', 'greenfield', 'agents', 'mine.md'), '# mine\n');
    expect(await edited()).toBe(true);
    expect(sweeps).toBeGreaterThan(0);
  }, 180_000);
});
