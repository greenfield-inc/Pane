import { describe, expect, it } from 'vitest';
import type { AgentFarmProfileEntry } from '../../../shared/types/agentFarmProfiles';
import { CONFIGURED_AGENT_IDS, configuredAgent } from '../../../shared/agents';
import { plainProfileAgents, plainProfileRef } from '../../../shared/agentProfiles';
import { filterProfileSwitchChoices, profileSwitchChoices, profileSwitchText } from './sessionProfileSwitch';

// Agent facts come from the config: the one whose profile switches keep the conversation, and the other.
const [keeps, apart] = [...plainProfileAgents()].sort((a, b) => Number(!configuredAgent(a).chat?.profileSwitchKeepsConversation) - Number(!configuredAgent(b).chat?.profileSwitchKeepsConversation));
const entry = (ref: string, harness: string, hidden = false): AgentFarmProfileEntry => ({ ref, plugin: ref.split('/')[0], version: '1', harness, hidden });
const profiles = [entry('team/lead', keeps), entry('team/coder', apart), entry(plainProfileRef(keeps)!, keeps, true)];
const other = CONFIGURED_AGENT_IDS.find(id => !plainProfileAgents().includes(id));

describe('Switch profile choices (T-63)', () => {
  it('lists the agents on their own, then visible profiles, saying which start a new conversation', () => {
    const choices = profileSwitchChoices({ agent: keeps, agentProfile: { ref: plainProfileRef(keeps)!, hash: 'h' } }, [...profiles, ...(other ? [entry('team/other', other)] : [])]);
    expect(choices.map(choice => [choice.ref, choice.effect])).toEqual([
      [plainProfileRef(keeps), 'current'],
      [plainProfileRef(apart), 'new-conversation'],
      ['team/lead', 'kept'],
      ['team/coder', 'new-conversation'],
    ]);
    expect(choices[0].detail).toBe('no profile');
    expect(choices[1].detail).toBe('no profile · new conversation');
    expect(choices[2]).toMatchObject({ label: 'Team lead', detail: 'team/lead', group: 'profiles', avatarRef: 'team/lead' });
  });

  it('keeps no conversation between two profiles of an agent whose homes Agent Farm keeps apart', () => {
    const choices = profileSwitchChoices({ agent: apart, agentProfile: { ref: plainProfileRef(apart)!, hash: 'h' } }, profiles);
    expect(choices.find(choice => choice.ref === 'team/coder')?.effect).toBe('new-conversation');
  });

  it('filters by name, ref or agent', () => {
    const choices = profileSwitchChoices({ agent: keeps }, profiles);
    expect(filterProfileSwitchChoices(choices, 'LEAD').map(choice => choice.ref)).toEqual(['team/lead']);
    expect(filterProfileSwitchChoices(choices, 'team/').length).toBe(2);
  });

  it('words the toast and the sheet', () => {
    const text = profileSwitchText({ name: 'Plan', agent: keeps }, { agent: apart, label: 'Team coder' });
    expect(text.done).toBe('Plan now runs Team coder · conversation kept');
    expect(text.confirmTitle).toBe(`Start a new ${configuredAgent(apart).label} conversation?`);
    expect(text.confirmReason).toContain(`can't continue a ${configuredAgent(keeps).label} conversation`);
  });
});
