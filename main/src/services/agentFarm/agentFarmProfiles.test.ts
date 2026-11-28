import { describe, expect, it } from 'vitest';
import { configuredAgent } from '../../../../shared/agents';
import { PROFILE_REF_PATTERN } from '../../../../shared/types/agentFarmProfiles';
import { panePluginFiles, parseProfileList, parseProfileListLine } from './agentFarmProfiles';
import { plainProfileAgent, plainProfileAgents, plainProfileRef } from '../../../../shared/agentProfiles';

// Lines as Agent Farm 0.2.34's `profiles list` prints them.
const LIST = [
  'dcouple/raw (opus: claude-opus-5-5 medium · astra: gpt-6-astra medium · sol: gpt-6.1-sol medium) -> raw-claude | plugin dcouple 0.1.27 | claude | claude-opus-5-5 medium | native default',
  'greenfield/product-researcher (astra: gpt-6-astra high fast · opus: claude-opus-5-5 high) -> astra-researcher [ambiguous bare name] | plugin greenfield 0.0.46 | codex | gpt-6-astra high | fast',
  'pane/claude -> claude | plugin pane 1.0.0 | claude | claude-opus-5-5 default | native default',
  'warning: something Agent Farm printed first',
  '',
].join('\n');

describe('parseProfileList', () => {
  it('reads each profile with its plugin, default harness and model, and its variants default first', () => {
    expect(parseProfileList(LIST)).toEqual([
      {
        ref: 'dcouple/raw', plugin: 'dcouple', version: '0.1.27', harness: 'claude', model: 'claude-opus-5-5', effort: 'medium', hidden: false,
        defaultVariant: 'opus',
        variants: [{ name: 'opus', model: 'claude-opus-5-5', effort: 'medium' }, { name: 'astra', model: 'gpt-6-astra', effort: 'medium' }, { name: 'sol', model: 'gpt-6.1-sol', effort: 'medium' }],
      },
      {
        ref: 'greenfield/product-researcher', plugin: 'greenfield', version: '0.0.46', harness: 'codex', model: 'gpt-6-astra', effort: 'high', hidden: false,
        defaultVariant: 'astra',
        variants: [{ name: 'astra', model: 'gpt-6-astra', effort: 'high' }, { name: 'opus', model: 'claude-opus-5-5', effort: 'high' }],
      },
      // Pane's plain profile: hidden, and "default" effort means none was set.
      { ref: 'pane/claude', plugin: 'pane', version: '1.0.0', harness: 'claude', model: 'claude-opus-5-5', hidden: true },
    ]);
  });

  it('marks a profile its plugin unlists, and leaves listing unsaid for an Agent Farm that says nothing (T-63)', () => {
    expect(parseProfileListLine('greenfield/planner -> planner | plugin greenfield 0.0.47 | claude | claude-opus-5-5 high | native default | unlisted'))
      .toMatchObject({ ref: 'greenfield/planner', listed: false });
    expect(parseProfileListLine('greenfield/orchestrator -> orchestrator | plugin greenfield 0.0.47 | claude | claude-opus-5-5 high | native default'))
      .not.toHaveProperty('listed');
  });

  it('skips a line in another shape', () => {
    expect(parseProfileListLine('pane/claude -> claude')).toBeUndefined();
    expect(parseProfileListLine('Not/A profile | plugin x 1 | claude | m')).toBeUndefined();
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
    expect(['greenfield/orchestrator', 'pane/claude', 'dcouple/raw:sol'].every(ref => PROFILE_REF_PATTERN.test(ref))).toBe(true);
    expect(['orchestrator', 'a/b/c', '../x', 'Greenfield/x', 'a/b:'].some(ref => PROFILE_REF_PATTERN.test(ref))).toBe(false);
  });
});
