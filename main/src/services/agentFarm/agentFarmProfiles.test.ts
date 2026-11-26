import { describe, expect, it } from 'vitest';
import { configuredAgent } from '../../../../shared/agents';
import { PROFILE_REF_PATTERN } from '../../../../shared/types/agentFarmProfiles';
import { linkedAgentRefs, panePluginFiles, parseProfileListJson, profileListEntries } from './agentFarmProfiles';
import { plainProfileAgent, plainProfileAgents, plainProfileRef } from '../../../../shared/agentProfiles';

// `agent-farm profiles list --json` as Agent Farm 0.3.0 prints it (CONFIGURATION.md), trimmed.
const LIST = JSON.stringify({
  schema: 1,
  profiles: [
    {
      ref: 'greenfield/orchestrator', name: 'orchestrator', plugin: 'greenfield', version: '0.1.0',
      title: 'Orchestrator', description: 'Software work.', photo: '/root/plugins/greenfield/profiles/orchestrator.svg',
      sources: { title: 'plugin', description: 'plugin', photo: 'plugin' },
      editable: { via: 'override', file: '/root/plugins/greenfield/profiles/orchestrator.yaml' },
      variants: {
        claude: { agent: 'greenfield/orchestrator', harness: 'claude', model: { name: 'claude-opus-5-5', reasoning: 'medium' } },
        codex: { agent: 'greenfield/orchestrator-codex', harness: 'codex', model: { name: 'gpt-6.2-sol', reasoning: 'medium', speed: 'ultrafast' } },
      },
      default: 'claude',
      command: 'agent-farm run greenfield/orchestrator',
      tree: [{ alias: 'planner', agent: 'greenfield/planner', mode: 'launch', variants: ['claude', 'codex'], default: 'claude', command: 'agent-farm run greenfield/planner --agent-only', children: [] }],
    },
    {
      ref: 'greenfield/seo', name: 'seo', plugin: 'greenfield', version: '0.1.0', title: null, description: null, photo: null,
      variants: null, default: null, agent: 'greenfield/seo', harness: 'codex', model: { name: 'gpt-6.2-sol', reasoning: 'high' },
      command: 'agent-farm run greenfield/seo', tree: [],
    },
    { ref: 'pane/claude', name: 'claude', plugin: 'pane', version: '1.0.0', variants: null, default: null, agent: 'pane/claude', harness: 'claude', model: { name: 'claude-opus-5-5' }, tree: [] },
    { ref: 'mine/broken', name: 'broken', plugin: 'mine', version: '0.1.0', error: 'agents/broken.md does not parse' },
  ],
});

// T-83 P3: a Session started from a launch link's command runs a linked agent, not a profile.
describe('linkedAgentRefs', () => {
  it('names each linked agent as it starts by name, its alias when that differs, and plugin/* for an any link', () => {
    expect(linkedAgentRefs(parseProfileListJson(LIST))).toEqual(['greenfield/planner']);
    const tree = [{ alias: 'explorer', agent: 'greenfield/codebase-explorer', mode: 'launch', children: [{ alias: 'helper', agent: 'helper', mode: 'process', children: [] }] }, { alias: 'anyone', mode: 'launch', any: true, plugin: 'other', children: [] }];
    const listing = JSON.stringify({ schema: 1, profiles: [{ ref: 'greenfield/orchestrator', name: 'orchestrator', plugin: 'greenfield', version: '0.1.0', agent: 'greenfield/orchestrator', harness: 'claude', tree }] });
    expect(linkedAgentRefs(parseProfileListJson(listing)).sort()).toEqual(['greenfield/codebase-explorer', 'greenfield/explorer', 'greenfield/helper', 'other/*']);
  });
});

describe('profileListEntries', () => {
  it('reads each profile with its title, description, default harness and model, and its variants default first', () => {
    expect(profileListEntries(parseProfileListJson(LIST))).toEqual([
      {
        ref: 'greenfield/orchestrator', plugin: 'greenfield', version: '0.1.0', harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', hidden: false,
        title: 'Orchestrator', description: 'Software work.',
        defaultVariant: 'claude',
        variants: [{ name: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, { name: 'codex', model: 'gpt-6.2-sol', effort: 'medium' }],
      },
      // A single-agent profile: no variants, and a null title or description is left out.
      { ref: 'greenfield/seo', plugin: 'greenfield', version: '0.1.0', harness: 'codex', model: 'gpt-6.2-sol', effort: 'high', hidden: false },
      // Pane's plain profile: hidden.
      { ref: 'pane/claude', plugin: 'pane', version: '1.0.0', harness: 'claude', model: 'claude-opus-5-5', hidden: true },
    ]);
  });

  it('leaves out a title Agent Farm only made from the name, so Pane makes its own', () => {
    const listing = JSON.stringify({ schema: 1, profiles: [{ ref: 'team/planner', name: 'planner', plugin: 'team', version: '0.1.0', title: 'planner', sources: { title: 'default' }, variants: null, agent: 'team/planner', harness: 'claude', tree: [] }] });
    expect(parseProfileListJson(listing)[0].title).toBeUndefined();
  });

  it('leaves out a profile Agent Farm could not resolve', () => {
    expect(profileListEntries(parseProfileListJson(LIST)).map(entry => entry.ref)).not.toContain('mine/broken');
  });

  it('refuses output that is not the JSON listing, saying what it got', () => {
    expect(() => parseProfileListJson('greenfield/orchestrator -> orchestrator | plugin greenfield 0.1.0 | claude | m')).toThrow(/profiles list --json/);
    expect(() => parseProfileListJson(JSON.stringify({ schema: 2, profiles: [] }))).toThrow(/schema 2/);
  });
});

describe('Pane\'s plain profiles', () => {
  it('are pane/<agent> for each agent the contract gives an Agent Farm model', () => {
    expect(plainProfileAgents()).toEqual(['claude', 'codex']);
    expect(plainProfileRef('claude')).toBe('pane/claude');
    expect(plainProfileRef('cursor')).toBeUndefined();
    expect(plainProfileAgent('pane/codex')).toBe('codex');
    expect(plainProfileAgent('pane/codex:fast')).toBe('codex');
    expect(plainProfileAgent('greenfield/orchestrator')).toBeUndefined();
    expect(plainProfileAgent('pane/cursor')).toBeUndefined();
  });

  it('hold only the harness and the contract\'s model: no instructions, skills or subagents', () => {
    const files = panePluginFiles();
    expect([...files.keys()].sort()).toEqual(['agents/claude.md', 'agents/codex.md', 'plugin.yaml', 'profiles/claude.yaml', 'profiles/codex.yaml']);
    expect(files.get('agents/codex.md')).toBe(`---\nharness: codex\nmodel:\n  name: "${configuredAgent('codex').chat?.profileModel}"\ndescription: "Codex on its own, as Pane starts a Session without a profile."\n---\n`);
  });
});

describe('PROFILE_REF_PATTERN', () => {
  it('takes plugin/profile with an optional variant', () => {
    expect(['greenfield/orchestrator', 'pane/claude', 'greenfield/orchestrator:codex'].every(ref => PROFILE_REF_PATTERN.test(ref))).toBe(true);
    expect(['orchestrator', 'a/b/c', '../x', 'Greenfield/x', 'a/b:'].some(ref => PROFILE_REF_PATTERN.test(ref))).toBe(false);
  });
});
