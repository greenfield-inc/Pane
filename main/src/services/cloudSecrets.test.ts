import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCloudSignIns } from './cloudSecrets';
import { PaneError } from '../../../shared/paneError';
import { paneSecretValueBackend, PaneSecretStore, volumeSecretIndex } from './paneSecrets';

const TOKEN = 'gho_DROPCANARY1234567890';
const dirs: string[] = [];
const logged: string[] = [];

/** A cloud VM's secrets volume and the store Pane keeps on it, as the daemon builds them. */
async function vm() {
  const volume = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-drop-volume-'));
  dirs.push(volume);
  const secrets = new PaneSecretStore(volumeSecretIndex(volume, () => ({})), paneSecretValueBackend('', volume), () => 'pane-1a2b3c4d');
  const env: NodeJS.ProcessEnv = {};
  const drop = path.join(volume, 'incoming', 'github-token.json');
  /** Writes the drop file as the guest's unseal unit does: 0600 in a 0700 folder, by rename. */
  const writeDrop = async (text: string) => {
    await fs.mkdir(path.dirname(drop), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${drop}.tmp`, text, { mode: 0o600 });
    await fs.rename(`${drop}.tmp`, drop);
  };
  return { volume, secrets, env, drop, writeDrop };
}

/** Every file under `dir` that holds `text`, by path relative to it. */
async function filesHolding(dir: string, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if ((await fs.readFile(file, 'utf8')).includes(text)) found.push(path.relative(dir, file));
  }
  return found;
}

describe('the GitHub token a new cloud VM is given before boot', () => {
  beforeEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // The token is never logged, whatever happened.
    expect(logged.join('\n')).not.toContain(TOKEN);
    logged.length = 0;
    await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
  });

  it('is imported as pane-cloud/GH_TOKEN with its source and time, put in the agents\' environment, and its file deleted', async () => {
    const { volume, secrets, env, drop, writeDrop } = await vm();
    await writeDrop(JSON.stringify({ token: TOKEN, source: 'mayas-macbook', updatedAt: '2026-11-22T10:00:00.000Z' }));

    await startCloudSignIns(secrets, volume, env);

    expect(await secrets.read('pane-cloud', 'GH_TOKEN')).toBe(TOKEN);
    expect(secrets.secretRecord('pane-cloud/GH_TOKEN')).toEqual({ updatedAt: '2026-11-22T10:00:00.000Z', source: 'mayas-macbook' });
    expect(env.GH_TOKEN).toBe(TOKEN);
    await expect(fs.access(drop)).rejects.toMatchObject({ code: 'ENOENT' });
    // The value sits only in the volume's value file: not in the index, not anywhere else.
    expect(await filesHolding(volume, TOKEN)).toEqual(['secrets.json']);
  });

  it('loses to a newer record already on the machine, and replaces an older one', async () => {
    const newer = await vm();
    await newer.secrets.applyFromSync({ 'pane-cloud/GH_TOKEN': { value: 'gho_newer', updatedAt: '2026-11-23T00:00:00.000Z', source: 'mac-studio' } });
    await newer.writeDrop(JSON.stringify({ token: TOKEN, source: 'mayas-macbook', updatedAt: '2026-11-22T10:00:00.000Z' }));
    await startCloudSignIns(newer.secrets, newer.volume, newer.env);
    expect(newer.env.GH_TOKEN).toBe('gho_newer');
    await expect(fs.access(newer.drop)).rejects.toMatchObject({ code: 'ENOENT' });

    const older = await vm();
    await older.secrets.applyFromSync({ 'pane-cloud/GH_TOKEN': { value: 'gho_older', updatedAt: '2026-11-01T00:00:00.000Z', source: 'mac-studio' } });
    await older.writeDrop(JSON.stringify({ token: TOKEN, source: 'mayas-macbook', updatedAt: '2026-11-22T10:00:00.000Z' }));
    await startCloudSignIns(older.secrets, older.volume, older.env);
    expect(older.env.GH_TOKEN).toBe(TOKEN);
  });

  it('is kept out when the person\'s choice keeps the token, or its machine, off cloud Sessions', async () => {
    for (const choice of [{ excludedSecrets: ['pane-cloud/GH_TOKEN'], excludedMachines: [] }, { excludedSecrets: [], excludedMachines: ['mayas-macbook'] }]) {
      const { volume, secrets, env, drop, writeDrop } = await vm();
      await secrets.setCloudChoice(choice);
      await writeDrop(JSON.stringify({ token: TOKEN, source: 'mayas-macbook', updatedAt: '2026-11-22T10:00:00.000Z' }));

      await startCloudSignIns(secrets, volume, env);

      expect(secrets.has('pane-cloud', 'GH_TOKEN')).toBe(false);
      expect(env.GH_TOKEN).toBeUndefined();
      await expect(fs.access(drop)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await filesHolding(volume, TOKEN)).toEqual([]);
    }
  });

  it('deletes a malformed file and says so, without quoting it', async () => {
    for (const text of [`{"token": "${TOKEN}", "source":`, JSON.stringify({ token: TOKEN, updatedAt: 'not a time', source: 'mayas-macbook' }), JSON.stringify({ token: '', source: 'x', updatedAt: '2026-11-22T10:00:00.000Z' })]) {
      const { volume, secrets, env, drop, writeDrop } = await vm();
      await writeDrop(text);

      const failure = await startCloudSignIns(secrets, volume, env).then(() => null, (error: Error) => error);

      expect(failure).toBeInstanceOf(PaneError);
      expect(failure).toMatchObject({ code: 'ERR_CLOUD_TOKEN_DROP_INVALID' });
      expect(`${failure?.message} ${failure instanceof PaneError ? failure.next : ''} ${failure?.stack}`).not.toContain(TOKEN);
      await expect(fs.access(drop)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(secrets.has('pane-cloud', 'GH_TOKEN')).toBe(false);
    }
  });

  it('changes nothing without a secrets volume or without the file, and still exports what the machine holds', async () => {
    const { volume, secrets, env } = await vm();
    await startCloudSignIns(secrets, undefined, env);
    await startCloudSignIns(secrets, volume, env);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(secrets.list()).toEqual([]);

    await secrets.applyFromSync({ 'pane-cloud/GH_TOKEN': { value: 'gho_synced', updatedAt: '2026-11-22T10:00:00.000Z', source: 'mac-studio' } });
    await startCloudSignIns(secrets, volume, env);
    expect(env.GH_TOKEN).toBe('gho_synced');
  });
});
