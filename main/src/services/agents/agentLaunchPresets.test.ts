import { describe, expect, it } from 'vitest';
import {
  AGENT_LAUNCH_PRESETS,
  agentPresetsForPlatform,
  isAgentSupportedOnPlatform,
} from '../../../../shared/constants/agentLaunchPresets';
import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';

describe('AGENT_LAUNCH_PRESETS', () => {
  it('builds each terminal launch command from the agents config: executable, full-access flags, then args', () => {
    expect(AGENT_LAUNCH_PRESETS.map(p => p.id).sort()).toEqual([...RUNPANE_CONTRACT.enums.agents].sort());
    expect(Object.fromEntries(AGENT_LAUNCH_PRESETS.map(p => [p.id, p.command]))).toEqual({
      claude: 'claude --dangerously-skip-permissions',
      codex: 'codex --yolo',
      cursor: 'cursor-agent --force --trust',
      opencode: 'opencode --auto',
      pi: 'pi',
    });
  });

  it('gives each preset its own hotkey and hotkey id', () => {
    expect(new Set(AGENT_LAUNCH_PRESETS.map(p => p.hotkey)).size).toBe(AGENT_LAUNCH_PRESETS.length);
    expect(new Set(AGENT_LAUNCH_PRESETS.map(p => p.hotkeyId)).size).toBe(AGENT_LAUNCH_PRESETS.length);
    expect(AGENT_LAUNCH_PRESETS.find(p => p.id === 'opencode')).toMatchObject({
      hotkeyId: 'add-tool-terminal-opencode',
      hotkey: 'mod+alt+6',
    });
  });

  it('supports cursor on POSIX hosts and WSL repos, but not native Windows', () => {
    expect(agentPresetsForPlatform('win32').map(p => p.id)).toEqual(['claude', 'codex', 'opencode', 'pi']);
    expect(agentPresetsForPlatform('darwin').map(p => p.id)).toEqual(['claude', 'codex', 'cursor', 'opencode', 'pi']);
    expect(agentPresetsForPlatform('linux').map(p => p.id)).toEqual(['claude', 'codex', 'cursor', 'opencode', 'pi']);
    expect(agentPresetsForPlatform('windows').map(p => p.id)).toEqual(['claude', 'codex', 'opencode', 'pi']);
    expect(agentPresetsForPlatform('macos').map(p => p.id)).toEqual(['claude', 'codex', 'cursor', 'opencode', 'pi']);
    expect(agentPresetsForPlatform('wsl').map(p => p.id)).toEqual(['claude', 'codex', 'cursor', 'opencode', 'pi']);
    expect(isAgentSupportedOnPlatform('cursor', 'windows')).toBe(false);
    expect(isAgentSupportedOnPlatform('cursor', 'wsl')).toBe(true);
    expect(isAgentSupportedOnPlatform('opencode', 'darwin')).toBe(true);
    expect(isAgentSupportedOnPlatform('opencode', 'linux')).toBe(true);
    expect(isAgentSupportedOnPlatform('opencode', 'wsl')).toBe(true);
    expect(isAgentSupportedOnPlatform('opencode', 'windows')).toBe(true);
    expect(AGENT_LAUNCH_PRESETS.find(p => p.id === 'opencode')?.platforms).toBeUndefined();
    expect(isAgentSupportedOnPlatform('pi', 'windows')).toBe(true);
    expect(AGENT_LAUNCH_PRESETS.find(p => p.id === 'pi')?.platforms).toBeUndefined();
  });
});
