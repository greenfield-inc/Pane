import type { IpcMain } from 'electron';
import { describe, expect, it } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerProfileHandlers } from './profiles';
import type { AppServices } from './types';

function registryWith(profilesEnabled: boolean | undefined): PaneCommandRegistry {
  const registry = new PaneCommandRegistry();
  const serviceFixture = { configManager: { getConfig: () => ({ profilesEnabled }) } };
  // SAFETY: The fixture supplies the only AppServices member the off check reads, and every case stops there.
  const services = serviceFixture as AppServices;
  const ipcMain = { handle: () => undefined };
  // SAFETY: The IpcMain stub only has to accept the channel bindings; the tests invoke the registry directly.
  registerProfileHandlers(ipcMain as IpcMain, services, registry);
  return registry;
}

describe('runpane profiles while Profiles is off', () => {
  it.each(['runpane:profiles:list', 'runpane:profiles:show', 'runpane:profiles:launch', 'runpane:profiles:runs'])('%s says Profiles is off and how to turn it on', async (channel) => {
    await expect(registryWith(undefined).invoke(channel, [{ name: 'greenfield', prompt: 'x' }])).rejects.toMatchObject({
      code: 'PROFILES_OFF',
      next: expect.stringContaining('Settings › Advanced › Profiles'),
    });
  });

  it('launching from the app is refused the same way', async () => {
    const response = await registryWith(false).invoke('profiles:launch', [{ profile: 'greenfield', repoId: 1, prompt: 'x' }]);
    expect(response).toMatchObject({ success: false, error: expect.stringContaining('Profiles is off') });
  });
});
