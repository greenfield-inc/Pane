import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleAgentPresets } from './agentPresets';

describe('visibleAgentPresets', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows Cursor for WSL repos on a Windows host', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });

    expect(visibleAgentPresets('wsl').map(preset => preset.id)).toEqual([
      'claude',
      'codex',
      'cursor',
      'opencode',
      'pi',
    ]);
  });

  it('keeps Cursor hidden for native Windows repos and host-level tools', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });

    expect(visibleAgentPresets('windows').map(preset => preset.id)).toEqual([
      'claude',
      'codex',
      'opencode',
      'pi',
    ]);
    expect(visibleAgentPresets().map(preset => preset.id)).toEqual([
      'claude',
      'codex',
      'opencode',
      'pi',
    ]);
  });

  it('uses the remote repository environment instead of the renderer platform', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(visibleAgentPresets('windows').map(preset => preset.id)).toEqual([
      'claude',
      'codex',
      'opencode',
      'pi',
    ]);

    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(visibleAgentPresets('macos').map(preset => preset.id)).toEqual([
      'claude',
      'codex',
      'cursor',
      'opencode',
      'pi',
    ]);
    expect(visibleAgentPresets('linux').map(preset => preset.id)).toEqual([
      'claude',
      'codex',
      'cursor',
      'opencode',
      'pi',
    ]);
  });
});
