import { CONFIGURED_AGENT_IDS, agentConfig, configuredAgent, type ConfiguredAgentId } from './agents';

/**
 * Pane's own Agent Farm plugin (T-63), as main writes it and the renderer shows it: one plain
 * profile, `pane/<agent>`, per agent whose config names an Agent Farm model.
 */
export const PANE_PROFILE_PLUGIN = 'pane';

/** The agents with a plain profile: those whose config names an Agent Farm model. */
export function plainProfileAgents(): ConfiguredAgentId[] {
  return CONFIGURED_AGENT_IDS.filter(id => !!configuredAgent(id).chat?.profileModel);
}

/** `pane/<agent>`, the plain profile of an agent, or undefined when Agent Farm doesn't run it. */
export function plainProfileRef(agent: string): string | undefined {
  return agentConfig(agent)?.chat?.profileModel ? `${PANE_PROFILE_PLUGIN}/${agent}` : undefined;
}

/** The agent of a plain profile ref (`pane/claude` → claude), or undefined for any other profile. */
export function plainProfileAgent(ref: string): ConfiguredAgentId | undefined {
  const [plugin, rest] = ref.split('/');
  if (plugin !== PANE_PROFILE_PLUGIN || !rest) return undefined;
  const agent = rest.split(':')[0];
  return plainProfileAgents().find(id => id === agent);
}
