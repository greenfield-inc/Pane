import { agentConfig, agentLabel, isConfiguredAgent } from '../../../shared/agents';
import type { AgentFarmProfileEntry } from '../../../shared/types/agentFarmProfiles';
import type { OrchestrationSessionCreateInput } from '../../../shared/types/orchestrationSession';
import { profileDisplayName } from './profileAvatar';
import { isTemporarilyShownProfile } from '../../../shared/agentProfiles';
import { pinnedFirst } from '../components/profiles/profilePins';

/**
 * What Create New's To offers (T-63), in this order: Claude and Codex on their own, the machine's
 * listed Agent Farm profiles, and the other agents, which start directly with no profile (A-1).
 * Profiles pinned in the Profiles tab go first, in pin order.
 */
export interface SessionChoice {
  key: string;
  group: 'agents' | 'profiles' | 'other';
  label: string;
  /** The second line: the model, the profile's ref and agent, or how it starts. */
  detail: string;
  agent: string;
  /** The Agent Farm profile it starts; absent for an agent on its own. */
  profileRef?: string;
  /** Why it can't start here now; it stays listed so the person sees it. */
  disabledReason?: string;
}

const WORD = /^[a-z]+$/;
const NUMBER = /^\d+(?:\.\d+)?$/;

/**
 * A model id as people write it: `<vendor>-<family>-<version…>` drops the vendor ("Opus 5.5"),
 * and `<name>-<version>-<words…>` keeps it as a capitalised prefix ("GPT-6 Astra"). Any other id
 * is shown as it is.
 */
export function modelDisplayName(model: string): string {
  const parts = model.split('-');
  const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  if (parts.length >= 3 && WORD.test(parts[0]) && WORD.test(parts[1]) && parts.slice(2).every(part => NUMBER.test(part))) {
    return `${title(parts[1])} ${parts.slice(2).join('.')}`;
  }
  if (parts.length >= 2 && WORD.test(parts[0]) && NUMBER.test(parts[1]) && parts.slice(2).every(part => WORD.test(part))) {
    return [`${parts[0].toUpperCase()}-${parts[1]}`, ...parts.slice(2).map(title)].join(' ');
  }
  return model;
}

export function sessionChoices({ agents, profiles, profilesUnavailable, pins = [] }: {
  /** The agents the machine can run a Session with, in config order. */
  agents: readonly string[];
  profiles: readonly AgentFarmProfileEntry[];
  /** Why profiles can't start on that machine now (chat tabs off, WSL); undefined when they can. */
  profilesUnavailable?: string;
  /** Pinned profiles (`plugin/profile`), which come first in pin order (T-63, build-6 feedback item 2). */
  pins?: readonly string[];
}): SessionChoice[] {
  const runsThroughAgentFarm = (agent: string) => !!agentConfig(agent)?.chat?.profileModel;
  const plain = agents.filter(runsThroughAgentFarm).map((agent): SessionChoice => {
    const model = agentConfig(agent)?.chat?.profileModel;
    return { key: `agent:${agent}`, group: 'agents', label: agentLabel(agent), detail: `${model ? modelDisplayName(model) : agentLabel(agent)} · nothing added`, agent };
  });
  // Pane's own plain profiles are hidden; a profile Agent Farm marks unlisted (a subagent's own) is
  // left out, and one from an Agent Farm that doesn't say counts as listed.
  // TEMPORARY (T-83): only the short list in shared/agentProfiles.ts is shown.
  const named = profiles.filter(entry => !entry.hidden && entry.listed !== false && isTemporarilyShownProfile(entry.ref) && agents.includes(entry.harness) && runsThroughAgentFarm(entry.harness)).map((entry): SessionChoice => {
    const choice: SessionChoice = {
      key: `profile:${entry.ref}`, group: 'profiles', label: profileDisplayName(entry.ref), detail: `${entry.ref} · ${agentLabel(entry.harness)}`,
      agent: entry.harness, profileRef: entry.ref,
    };
    if (profilesUnavailable) choice.disabledReason = profilesUnavailable;
    return choice;
  });
  const others = agents.filter(agent => !runsThroughAgentFarm(agent) && isConfiguredAgent(agent)).map((agent): SessionChoice => ({
    key: `other:${agent}`, group: 'other', label: agentLabel(agent), detail: 'Starts directly · no profiles or Agent Farm', agent,
  }));
  const pinned = (choice: SessionChoice) => !!choice.profileRef && pins.includes(choice.profileRef.split(':')[0]);
  const pinnedChoices = pinnedFirst(named.filter(pinned), pins, choice => choice.profileRef);
  return [...pinnedChoices, ...plain, ...named.filter(choice => !pinned(choice)), ...others];
}

export function filterSessionChoices(choices: readonly SessionChoice[], query: string): SessionChoice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...choices];
  return choices.filter(choice => choice.label.toLowerCase().includes(needle) || (choice.profileRef ?? '').includes(needle));
}

/** The create fields a choice sets: a profile's ref picks its own agent; the rest name the agent. */
export function sessionChoiceInput(choice: SessionChoice): Pick<OrchestrationSessionCreateInput, 'agent' | 'agentProfile'> {
  const agent = isConfiguredAgent(choice.agent) ? choice.agent : undefined;
  return choice.profileRef ? { agent, agentProfile: choice.profileRef } : { agent };
}
