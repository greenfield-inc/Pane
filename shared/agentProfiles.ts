import { CONFIGURED_AGENT_IDS, agentConfig, agentLabel, configuredAgent, type ConfiguredAgentId } from './agents';
import type { ChatDividerProfiles } from './types/chatTab';

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

/**
 * The profile a chat tab runs (T-63 round 5): its profile launch's ref, else the agent's plain
 * profile (`pane/<agent>`), else undefined for an agent Agent Farm doesn't run.
 */
export function launchProfileRef(agent: string, launch: { kind: 'agent' } | { kind: 'profile'; profile: string }): string | undefined {
  return launch.kind === 'profile' ? launch.profile : plainProfileRef(agent);
}

/** A divider's profiles, leaving out what isn't known (T-63 round 5). */
export function dividerProfiles(profile: string | undefined, previous: string | undefined): ChatDividerProfiles {
  const known: ChatDividerProfiles = {};
  if (profile) known.profile = profile;
  if (previous) known.previous = previous;
  return known;
}

/**
 * What switching a Session's agent from one profile to another does to its conversation (T-63):
 * `current` when nothing changes; `kept` when the agent continues the same conversation with the new
 * profile; `new-conversation` when it can't (another agent, or an agent whose conversations Agent Farm
 * keeps per profile), so a new one starts and is given the old transcript. Pane asks first only then.
 */
export type ProfileSwitchEffect = 'current' | 'kept' | 'new-conversation';

export function profileSwitchEffect(from: { agent: string; ref?: string }, to: { agent: string; ref: string }): ProfileSwitchEffect {
  if (from.agent !== to.agent) return 'new-conversation';
  if (from.ref === to.ref) return 'current';
  return agentConfig(to.agent)?.chat?.profileSwitchKeepsConversation === true ? 'kept' : 'new-conversation';
}

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * A profile's name as people see it: Agent Farm's title when the list gives one (T-83), else
 * "Greenfield orchestrator" for `greenfield/orchestrator`; a plain profile is its agent's name.
 */
export function profileEntryName(entry: { ref: string; title?: string }): string {
  return plainProfileAgent(entry.ref) ? profileDisplayName(entry.ref) : entry.title?.trim() || profileDisplayName(entry.ref);
}

/** "Greenfield orchestrator" for `greenfield/orchestrator`; a plain profile is its agent's name. */
export function profileDisplayName(ref: string): string {
  const plain = plainProfileAgent(ref);
  if (plain) return agentLabel(plain);
  const [name, variant] = ref.split(':');
  const [plugin = '', profile = ''] = name.split('/');
  const base = plugin === profile || !profile ? capitalized(plugin) : `${capitalized(plugin)} ${profile}`;
  return variant ? `${base} (${variant})` : base;
}
