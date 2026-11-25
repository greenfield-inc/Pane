import { agentLabel } from '../../../shared/agents';
import { plainProfileAgents, plainProfileRef, profileDisplayName, profileSwitchEffect, type ProfileSwitchEffect } from '../../../shared/agentProfiles';
import type { AgentFarmProfileEntry } from '../../../shared/types/agentFarmProfiles';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';

/** One row of a Session's Switch profile submenu (T-63). */
export interface ProfileSwitchChoice {
  key: string;
  group: 'agents' | 'profiles';
  label: string;
  /** "no profile" or the ref, with "· new conversation" when the switch can't keep the conversation. */
  detail: string;
  agent: string;
  /** What the Session runs after the switch: `pane/<agent>` for an agent on its own. */
  ref: string;
  /** The profile shown on the avatar: none for an agent on its own, which shows its logo. */
  avatarRef?: string;
  effect: ProfileSwitchEffect;
}

/**
 * Claude and Codex on their own, then this computer's profiles of the agents Agent Farm runs, each with
 * what switching to it does to the Session's conversation.
 */
export function profileSwitchChoices(session: Pick<OrchestrationSessionRecord, 'agent' | 'agentProfile'>, profiles: readonly AgentFarmProfileEntry[]): ProfileSwitchChoice[] {
  const from = { agent: session.agent, ref: session.agentProfile?.ref };
  const agents = plainProfileAgents();
  const choice = (key: string, group: ProfileSwitchChoice['group'], label: string, detail: string, agent: string, ref: string, avatarRef?: string): ProfileSwitchChoice => {
    const effect = profileSwitchEffect(from, { agent, ref });
    return { key, group, label, detail: effect === 'new-conversation' ? `${detail} · new conversation` : detail, agent, ref, avatarRef, effect };
  };
  const plain = agents.flatMap(agent => {
    const ref = plainProfileRef(agent);
    return ref ? [choice(`agent:${agent}`, 'agents', agentLabel(agent), 'no profile', agent, ref)] : [];
  });
  const named = profiles
    .filter(entry => !entry.hidden && agents.some(agent => agent === entry.harness))
    .map(entry => choice(`profile:${entry.ref}`, 'profiles', profileDisplayName(entry.ref), entry.ref, entry.harness, entry.ref, entry.ref));
  return [...plain, ...named];
}

export function filterProfileSwitchChoices(choices: readonly ProfileSwitchChoice[], query: string): ProfileSwitchChoice[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...choices];
  return choices.filter(choice => choice.label.toLowerCase().includes(needle) || choice.ref.includes(needle) || choice.agent.includes(needle));
}

/** The words for a switch: the toast after it, and the sheet that asks first when the conversation can't go on. */
export function profileSwitchText(session: Pick<OrchestrationSessionRecord, 'name' | 'agent'>, choice: Pick<ProfileSwitchChoice, 'agent' | 'label'>) {
  const to = agentLabel(choice.agent);
  const from = agentLabel(session.agent);
  return {
    done: `${session.name} now runs ${choice.label} · conversation kept`,
    confirmTitle: `Start a new ${to} conversation?`,
    confirmReason: choice.agent === session.agent
      ? `${to} keeps each profile's conversations apart, so a new one starts here and is given this transcript to read first.`
      : `${to} can't continue a ${from} conversation, so a new one starts here and is given this transcript to read first.`,
  };
}
