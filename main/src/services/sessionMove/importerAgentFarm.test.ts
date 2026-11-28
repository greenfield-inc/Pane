import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentFarmProfiles } from './importer';
import { readProfilesSwitchFrom } from '../agentFarm/profilesFeature';
import { agentFarmConfigRoot, installBundledAgentFarm } from '../agentFarm/bundledAgentFarm';

/** Which Agent Farm a Session move asks for profiles (T-63): PATH's with Profiles off, as on main; Pane's with it on. */

let root: string;
let shellPath: () => string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'pane-move-agent-farm-'));
  vi.stubEnv('PANE_DIR', path.join(root, 'pane'));
  // The person's own agent-farm on PATH: lists one profile only it has.
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const cli = path.join(bin, 'agent-farm');
  writeFileSync(cli, "#!/bin/sh\necho 'mine/own  Own agent | plugin mine 7.7.7'\n");
  chmodSync(cli, 0o755);
  shellPath = () => `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
});

afterEach(() => {
  readProfilesSwitchFrom(() => undefined);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('a Session move\'s Agent Farm', () => {
  it.skipIf(process.platform === 'win32')('is the person\'s own on PATH while Profiles is off', async () => {
    readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: false }));
    expect(await agentFarmProfiles(shellPath)).toEqual({ 'mine/own': '7.7.7' });
  });

  it.skipIf(process.platform === 'win32')('is Pane\'s bundled copy while Profiles is on, never the one on PATH', async () => {
    readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: true }));
    // Review F-9: positive evidence. Pane's copy lists the plugins installed in its own config root.
    const status = await installBundledAgentFarm({ paneDir: path.join(root, 'pane'), telemetry: false, log: () => undefined });
    expect(status.state).toBe('ready');
    const profiles = await agentFarmProfiles(shellPath);
    expect(profiles).not.toHaveProperty('mine/own');
    expect(Object.keys(profiles).some(name => name.startsWith('greenfield/'))).toBe(true);
  }, 60_000);

  it.skipIf(process.platform === 'win32')('leaves out a profile that fails to resolve, so a move never counts it as runnable', async () => {
    readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: true }));
    // Review F-3: seo links to seo-writer; without it Agent Farm still lists seo's ref and version, with an error.
    const status = await installBundledAgentFarm({ paneDir: path.join(root, 'pane'), telemetry: false, log: () => undefined });
    expect(status.state).toBe('ready');
    rmSync(path.join(agentFarmConfigRoot(path.join(root, 'pane')), 'plugins', 'greenfield', 'agents', 'seo-writer.md'));
    const profiles = await agentFarmProfiles(shellPath);
    expect(profiles).toHaveProperty('greenfield/orchestrator');
    expect(profiles).not.toHaveProperty('greenfield/seo');
  }, 60_000);
});
