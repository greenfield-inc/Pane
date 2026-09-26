import { describe, expect, it } from 'vitest';
import {
  AGENT_LAUNCH_PRESETS,
  agentPresetsForPlatform,
  isAgentSupportedOnPlatform,
} from '../../../../shared/constants/agentLaunchPresets';
import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';
import { getCatalogEntry } from '../../../../shared/constants/keyboardShortcuts';

describe('AGENT_LAUNCH_PRESETS', () => {
  it('mirrors the RunPane contract agent templates exactly', () => {
    expect(AGENT_LAUNCH_PRESETS.map(p => p.id).sort()).toEqual([...RUNPANE_CONTRACT.enums.agents].sort());
    for (const preset of AGENT_LAUNCH_PRESETS) {
      const template = RUNPANE_CONTRACT.agentTemplates[preset.id];
      expect(preset.title, `${preset.id} title`).toBe(template.title);
      expect(preset.command, `${preset.id} command`).toBe(template.command);
    }
  });

  it('maps every preset to its catalog default', () => {
    expect(AGENT_LAUNCH_PRESETS.map(p => getCatalogEntry(p.hotkeyId)?.defaultChord))
      .toEqual(['mod+alt+3', 'mod+alt+4', 'mod+alt+5']);
    expect(new Set(AGENT_LAUNCH_PRESETS.map(p => p.hotkeyId)).size).toBe(AGENT_LAUNCH_PRESETS.length);
  });

  it('supports cursor on POSIX hosts and WSL repos, but not native Windows', () => {
    expect(agentPresetsForPlatform('win32').map(p => p.id)).toEqual(['claude', 'codex']);
    expect(agentPresetsForPlatform('darwin').map(p => p.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(agentPresetsForPlatform('linux').map(p => p.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(agentPresetsForPlatform('windows').map(p => p.id)).toEqual(['claude', 'codex']);
    expect(agentPresetsForPlatform('macos').map(p => p.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(agentPresetsForPlatform('wsl').map(p => p.id)).toEqual(['claude', 'codex', 'cursor']);
    expect(isAgentSupportedOnPlatform('cursor', 'windows')).toBe(false);
    expect(isAgentSupportedOnPlatform('cursor', 'wsl')).toBe(true);
  });
});
