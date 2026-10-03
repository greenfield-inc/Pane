import { AgentLaunchPreset, agentPresetsForPlatform } from '../../../shared/constants/agentLaunchPresets';
import type { ProjectEnvironment } from '../../../shared/types/panels';
import { rendererPlatform } from './platformUtils';

export type { AgentLaunchPreset };

export function visibleAgentPresets(projectEnvironment?: ProjectEnvironment): readonly AgentLaunchPreset[] {
  const platform = projectEnvironment ?? rendererPlatform();
  return agentPresetsForPlatform(platform);
}
