import { describe, expect, it } from 'vitest';
import { agentTerminalCommand } from '../../../../shared/agents';
import { AGENT_FARM_RESUME } from '../../../../shared/types/customCommandResume';
import { imagesBlocked, opensInChat, textBlocked, type FirstMessageTarget } from './firstMessageDelivery';

const here: FirstMessageTarget = {
  here: true, machineName: 'This computer', runtimes: { distributions: [], promptAtLaunch: true, chatTabs: true },
  chatTabsHere: true, wsl: false, agent: 'claude', profile: false, launchCommand: '', customResume: null,
};

describe('Create New first message delivery (T-63)', () => {
  it('opens in a chat for a chat agent with its own launch, and in a terminal otherwise', () => {
    expect(opensInChat(here)).toBe(true);
    expect(opensInChat({ ...here, launchCommand: agentTerminalCommand('claude') })).toBe(true);
    expect(opensInChat({ ...here, customResume: { ...AGENT_FARM_RESUME } })).toBe(true);
    expect(opensInChat({ ...here, agent: 'pi' })).toBe(false);
    expect(opensInChat({ ...here, launchCommand: 'my-wrapper claude' })).toBe(false);
    expect(opensInChat({ ...here, customResume: { mode: 'generated', initialTemplate: 'x {id}', resumeTemplate: 'x --resume {id}' } })).toBe(false);
    expect(opensInChat({ ...here, wsl: true })).toBe(false);
    expect(opensInChat({ ...here, chatTabsHere: false })).toBe(false);
    // Another machine opens chats only when it says its chat tabs are on.
    expect(opensInChat({ ...here, here: false, chatTabsHere: true, runtimes: { distributions: [] } })).toBe(false);
    expect(opensInChat({ ...here, here: false, chatTabsHere: false, runtimes: { distributions: [], chatTabs: true } })).toBe(true);
  });

  it('refuses images a terminal would drop: another machine, WSL, chat tabs off, and an agent with no chat (F-2)', () => {
    expect(imagesBlocked(here)).toBeUndefined();
    expect(imagesBlocked({ ...here, here: false })).toMatch(/runs on this computer/);
    expect(imagesBlocked({ ...here, wsl: true })).toMatch(/WSL/);
    expect(imagesBlocked({ ...here, chatTabsHere: false })).toMatch(/Turn on Chat tabs/);
    expect(imagesBlocked({ ...here, agent: 'pi' })).toMatch(/Pi runs in a terminal/);
    expect(imagesBlocked({ ...here, launchCommand: 'my-wrapper claude' })).toMatch(/launch settings run it in a terminal/);
  });

  it('refuses text a PowerShell or cmd terminal could not take, and waits while the machine is read (F-4)', () => {
    const windows = { ...here, chatTabsHere: false, runtimes: { distributions: [], promptAtLaunch: false, chatTabs: false } };
    expect(textBlocked(windows)).toMatch(/PowerShell or cmd/);
    // A chat takes it; so does WSL's shell; so does a POSIX shell.
    expect(textBlocked({ ...windows, chatTabsHere: true })).toBeUndefined();
    expect(textBlocked({ ...windows, wsl: true })).toBeUndefined();
    expect(textBlocked({ ...windows, runtimes: { distributions: [], promptAtLaunch: true } })).toBeUndefined();
    expect(textBlocked({ ...windows, runtimes: null })).toMatch(/^Checking how this computer/);
    // A remote Pane from before T-63 doesn't say: sent as before.
    expect(textBlocked({ ...windows, here: false, machineName: 'win-box', runtimes: { distributions: [] } })).toBeUndefined();
    expect(textBlocked({ ...windows, here: false, machineName: 'win-box' })).toMatch(/^On win-box .* on win-box,/);
  });
});
