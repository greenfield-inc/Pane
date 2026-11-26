import { describe, expect, it } from 'vitest';
import type { AgentFarmProfileEntry } from '../../../shared/types/agentFarmProfiles';
import { filterSessionChoices, modelDisplayName, sessionChoiceInput, sessionChoices } from './sessionChoices';

const profile = (ref: string, harness = 'claude', extra: Partial<AgentFarmProfileEntry> = {}): AgentFarmProfileEntry => ({
  ref, plugin: ref.split('/')[0], version: '1.0.0', harness, hidden: ref.startsWith('pane/'), ...extra,
});

const PROFILES = [
  profile('pane/claude'), profile('pane/codex', 'codex'),
  profile('greenfield/orchestrator'), profile('greenfield/seo', 'codex'), profile('greenfield/business'),
];

describe('sessionChoices', () => {
  it('lists Claude and Codex, then the profiles (Pane\'s own hidden), then Other agents', () => {
    const choices = sessionChoices({ agents: ['claude', 'codex', 'cursor', 'opencode', 'pi'], profiles: PROFILES });
    expect(choices.map(choice => [choice.group, choice.label])).toEqual([
      ['agents', 'Claude'], ['agents', 'Codex'],
      ['profiles', 'Greenfield orchestrator'], ['profiles', 'Greenfield seo'], ['profiles', 'Greenfield business'],
      ['other', 'Cursor'], ['other', 'OpenCode'], ['other', 'Pi'],
    ]);
  });

  it('says what each choice runs', () => {
    const choices = sessionChoices({ agents: ['claude', 'codex', 'cursor'], profiles: PROFILES });
    expect(choices.find(choice => choice.label === 'Claude')?.detail).toBe('Opus 5.5 · nothing added');
    expect(choices.find(choice => choice.label === 'Greenfield seo')?.detail).toBe('greenfield/seo · Codex');
    expect(choices.find(choice => choice.label === 'Cursor')?.detail).toBe('Starts directly · no profiles or Agent Farm');
  });

  it('leaves out agents the machine cannot run, and profiles whose agent it cannot run', () => {
    const choices = sessionChoices({ agents: ['claude', 'opencode'], profiles: PROFILES });
    expect(choices.map(choice => choice.label)).toEqual(['Claude', 'Greenfield orchestrator', 'Greenfield business', 'OpenCode']);
  });

  it('offers every profile Agent Farm lists, from any plugin, except Pane\'s own (T-83)', () => {
    const choices = sessionChoices({ agents: ['claude'], profiles: [profile('pane/claude'), profile('writer/writer'), profile('greenfield/orchestrator:codex'), profile('greenfield/business')] });
    expect(choices.filter(choice => choice.group === 'profiles').map(choice => choice.profileRef)).toEqual(['writer/writer', 'greenfield/orchestrator:codex', 'greenfield/business']);
  });

  it('names a profile by Agent Farm\'s title when it has one, else by its ref', () => {
    const choices = sessionChoices({ agents: ['claude'], profiles: [profile('greenfield/orchestrator', 'claude', { title: 'Orchestrator' }), profile('greenfield/business', 'claude', { title: '  ' })] });
    expect(choices.filter(choice => choice.group === 'profiles').map(choice => [choice.label, choice.detail])).toEqual([
      ['Orchestrator', 'greenfield/orchestrator · Claude'], ['Greenfield business', 'greenfield/business · Claude'],
    ]);
    expect(filterSessionChoices(choices, 'orches').map(choice => choice.profileRef)).toEqual(['greenfield/orchestrator']);
  });

  it('puts pinned profiles first, in pin order', () => {
    const choices = sessionChoices({ agents: ['claude', 'codex'], profiles: PROFILES, pins: ['greenfield/business', 'greenfield/orchestrator'] });
    expect(choices.map(choice => choice.label)).toEqual(['Greenfield business', 'Greenfield orchestrator', 'Claude', 'Codex', 'Greenfield seo']);
  });

  it('keeps profiles listed but unavailable, with the reason, when they cannot start', () => {
    const choices = sessionChoices({ agents: ['claude'], profiles: PROFILES, profilesUnavailable: 'Turn on Chat tabs first.' });
    expect(choices.filter(choice => choice.group === 'profiles').map(choice => choice.disabledReason)).toEqual(['Turn on Chat tabs first.', 'Turn on Chat tabs first.']);
    expect(choices.find(choice => choice.label === 'Claude')?.disabledReason).toBeUndefined();
  });
});

describe('filterSessionChoices', () => {
  const choices = sessionChoices({ agents: ['claude', 'codex', 'cursor'], profiles: PROFILES });
  it('matches the name or the profile ref, ignoring case', () => {
    expect(filterSessionChoices(choices, 'SEO').map(choice => choice.label)).toEqual(['Greenfield seo']);
    expect(filterSessionChoices(choices, 'greenfield/orch').map(choice => choice.label)).toEqual(['Greenfield orchestrator']);
    expect(filterSessionChoices(choices, 'cur').map(choice => choice.label)).toEqual(['Cursor']);
    expect(filterSessionChoices(choices, '  ')).toEqual(choices);
  });
});

describe('sessionChoiceInput', () => {
  it('starts Claude or Codex on its own, a profile by its ref, and other agents directly', () => {
    const choices = sessionChoices({ agents: ['claude', 'cursor'], profiles: PROFILES });
    expect(sessionChoiceInput(choices[0])).toEqual({ agent: 'claude' });
    expect(sessionChoiceInput(choices[1])).toEqual({ agent: 'claude', agentProfile: 'greenfield/orchestrator' });
    expect(sessionChoiceInput(choices[3])).toEqual({ agent: 'cursor' });
  });
});

describe('modelDisplayName', () => {
  it('names Claude and GPT models as people write them, and leaves others as they are', () => {
    expect(modelDisplayName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelDisplayName('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelDisplayName('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelDisplayName('gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(modelDisplayName('llama3')).toBe('llama3');
  });
});
