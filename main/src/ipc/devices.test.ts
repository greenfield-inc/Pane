import type { IpcMain } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import type { PaneDaemonCaller } from '../../../shared/types/daemon';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { registerDeviceHandlers } from './devices';

function setup(enabled = true) {
  const registry = new PaneCommandRegistry();
  const serviceFixture = {
    sessionManager: { getSession: (id: string) => (id === 'pane-a' ? { name: 'qa', worktreePath: '/nonexistent' } : undefined), on: vi.fn() },
    configManager: { getConfig: () => ({ devices: { enabled } }) },
  };
  // SAFETY: The fixture supplies the AppServices members the device guard reads before any device work.
  const services = serviceFixture as AppServices;
  // SAFETY: The stub only records Settings registrations, which these tests do not call.
  registerDeviceHandlers({ handle: vi.fn() } as Pick<IpcMain, 'handle'>, services, registry);
  return registry;
}

async function code(work: Promise<PaneCommandValue>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (cause) {
    return cause instanceof PaneError ? cause.code : String(cause);
  }
}

const inPaneA: PaneDaemonCaller = { paneId: 'pane-a', panelId: 'agent-tab' };
const signal = new AbortController().signal;

describe('device tools: the Pane guard', () => {
  it('refuses a call from outside any Pane tab', async () => {
    const registry = setup();
    expect(await code(registry.invokeConnected('runpane:devices:open', [{ platform: 'ios' }], signal))).toBe('ERR_DEVICE_NO_PANE');
    expect(await code(registry.invokeConnected('runpane:devices:act', [{ args: ['snapshot'] }], signal, { paneId: 'gone' }))).toBe('ERR_DEVICE_NO_PANE');
  });

  it('refuses a call that came from another machine', async () => {
    const registry = setup();
    expect(await code(registry.invokeRemote('runpane:devices:screenshot', [{}], { caller: inPaneA }))).toBe('ERR_DEVICE_LOCAL_ONLY');
  });

  it('refuses every tool while Settings has them turned off', async () => {
    const registry = setup(false);
    expect(await code(registry.invokeConnected('runpane:devices:open', [{ platform: 'android' }], signal, inPaneA))).toBe('ERR_DEVICE_TOOLS_OFF');
  });

  it('refuses device_act flags that point at another device before anything runs', async () => {
    const registry = setup();
    expect(await code(registry.invokeConnected('runpane:devices:act', [{ args: ['press', '@e1', '--udid', 'OTHER'] }], signal, inPaneA))).toBe('ERR_DEVICE_ACT_FLAG');
  });

  it('keeps the device tab\'s channels from agents', async () => {
    const registry = setup();
    const answer = await registry.invokeConnected('devices:take-over', ['tab-a'], signal, inPaneA);
    expect(answer).toMatchObject({ success: false });
    expect(JSON.stringify(answer)).toContain('belongs to the person\'s device tab');
  });
});
