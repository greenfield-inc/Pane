import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { resetPaneRuntimeForTests, setPaneRuntime, type PaneRuntime } from '../core/runtime';
import type { ConfigManager } from '../services/configManager';
import type { AppConfig } from '../types/config';
import type { AppServices } from './types';
import { registerChatTabHandlers } from './chatTabs';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member the set-key handler reads.
  return value as Contract;
}

function host(chatTabsEnabled: boolean): PaneCommandRegistry {
  setPaneRuntime(partial<PaneRuntime>({ getConfigManager: () => partial<ConfigManager>({ getConfig: () => partial<AppConfig>({ chatTabsEnabled }) }) }));
  const registry = new PaneCommandRegistry();
  registerChatTabHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({}), registry);
  return registry;
}

describe('saving a chat tab key', () => {
  afterEach(() => resetPaneRuntimeForTests());

  it('refuses a teammate, whether saving or removing the owner\'s key', async () => {
    const registry = host(true);
    await expect(registry.invokeRemote('chat-tab:set-key', ['claude', 'sk-teammate'], { teammate: 'bob@example.com' })).rejects.toMatchObject({ code: 'SECRET_OWNER_REQUIRED' });
    await expect(registry.invokeRemote('chat-tab:set-key', ['claude', null], { teammate: 'bob@example.com' })).rejects.toMatchObject({ code: 'SECRET_OWNER_REQUIRED' });
  });

  it('saves no key with chat tabs off, but still removes one', async () => {
    const registry = host(false);
    await expect(registry.invokeRemote('chat-tab:set-key', ['claude', 'sk-owner'])).rejects.toMatchObject({ code: 'CHAT_TABS_DISABLED' });
    await expect(registry.invokeRemote('chat-tab:set-key', ['claude', null])).resolves.toEqual({ claude: false, codex: false });
  });
});
