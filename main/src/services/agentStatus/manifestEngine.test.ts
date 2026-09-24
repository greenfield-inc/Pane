import { describe, expect, it } from 'vitest';
import {
  detectAgentState,
  extractRegion,
  ruleMatches,
  type AgentManifest,
  type ManifestRule,
} from './manifestEngine';

const input = (screen: string, oscTitle = '', oscProgress = '') => ({
  screen,
  oscTitle,
  oscProgress,
});

const rule = (partial: Partial<ManifestRule> & { id: string }): ManifestRule => ({
  state: 'blocked',
  priority: 100,
  region: 'whole_recent',
  ...partial,
});

const manifest = (rules: ManifestRule[]): AgentManifest => ({ id: 'test', rules });

describe('extractRegion', () => {
  it('returns osc fields for osc regions and screen for whole_recent', () => {
    const i = input('line a\nline b', 'the title', '4;0');
    expect(extractRegion(i, 'osc_title')).toBe('the title');
    expect(extractRegion(i, 'osc_progress')).toBe('4;0');
    expect(extractRegion(i, 'whole_recent')).toBe('line a\nline b');
  });

  it('bottom_non_empty_lines(N) keeps the last N non-empty lines to end', () => {
    const i = input('one\n\ntwo\nthree\n\n');
    expect(extractRegion(i, 'bottom_non_empty_lines(2)')).toBe('two\nthree\n\n');
    expect(extractRegion(i, 'bottom_non_empty_lines(1)')).toBe('three\n\n');
  });

  it('after_last_horizontal_rule returns everything after the last rule (or all if none)', () => {
    expect(extractRegion(input('a\nb\nc'), 'after_last_horizontal_rule')).toBe('a\nb\nc');
    expect(
      extractRegion(input('head\n──────\ntail line'), 'after_last_horizontal_rule'),
    ).toBe('tail line');
  });

  it('after_last_prompt_marker returns content after the last codex prompt line', () => {
    expect(
      extractRegion(input('output\n› typed prompt\nbelow'), 'after_last_prompt_marker'),
    ).toBe('below');
  });

  it('prompt_box_body returns the body between the box borders', () => {
    const screen = 'context\n──────\n ❯ hello \n──────';
    expect(extractRegion(input(screen), 'prompt_box_body').trim()).toBe('❯ hello');
  });
});

describe('ruleMatches', () => {
  it('contains is case-insensitive and AND-combined', () => {
    const r = rule({ id: 'c', contains: ['Do you want', 'proceed?'] });
    expect(ruleMatches(r, 'DO YOU WANT to PROCEED?')).toBe(true);
    expect(ruleMatches(r, 'do you want to continue?')).toBe(false);
  });

  it('not gate blocks an otherwise-matching rule', () => {
    const r = rule({ id: 'n', contains: ['proceed'], not: [{ contains: ['select model'] }] });
    expect(ruleMatches(r, 'proceed?')).toBe(true);
    expect(ruleMatches(r, 'proceed? select model')).toBe(false);
  });

  it('any gate requires at least one child to match', () => {
    const r = rule({ id: 'a', any: [{ contains: ['yes'] }, { contains: ['❯'] }] });
    expect(ruleMatches(r, 'press yes')).toBe(true);
    expect(ruleMatches(r, 'nothing here')).toBe(false);
  });

  it('lineRegex must match some line', () => {
    const r = rule({ id: 'l', lineRegex: [/^\s*❯?\s*1\.\s*yes\b/i] });
    expect(ruleMatches(r, 'prefix\n  ❯ 1. Yes, do it\nsuffix')).toBe(true);
    expect(ruleMatches(r, 'no numbered option')).toBe(false);
  });
});

describe('detectAgentState', () => {
  it('falls back to idle with no matched rule for a known agent', () => {
    const m = manifest([rule({ id: 'blk', contains: ['do you want to proceed?'] })]);
    const result = detectAgentState(m, input('❯ just a prompt'));
    expect(result.state).toBe('idle');
    expect(result.matchedRuleId).toBeNull();
    expect(result.visibleBlocker).toBe(false);
  });

  it('selects the highest-priority matching rule', () => {
    const m = manifest([
      rule({ id: 'low', priority: 100, state: 'idle', contains: ['prompt'] }),
      rule({ id: 'high', priority: 900, state: 'blocked', contains: ['proceed'] }),
    ]);
    const result = detectAgentState(m, input('prompt — do you want to proceed'));
    expect(result.state).toBe('blocked');
    expect(result.matchedRuleId).toBe('high');
  });

  it('resolves equal-priority matches to the earlier rule', () => {
    const m = manifest([
      rule({ id: 'low', priority: 100, state: 'idle', contains: ['proceed'] }),
      rule({ id: 'first', priority: 500, state: 'blocked', contains: ['proceed'] }),
      rule({ id: 'second', priority: 500, state: 'working', contains: ['proceed'] }),
    ]);
    expect(detectAgentState(m, input('do you want to proceed')).matchedRuleId).toBe('first');
  });

  it('sets visibleBlocker only when the matched blocked rule declares it', () => {
    const m = manifest([
      rule({ id: 'blk', state: 'blocked', visibleBlocker: true, contains: ['proceed?'] }),
    ]);
    const result = detectAgentState(m, input('do you want to proceed?'));
    expect(result.state).toBe('blocked');
    expect(result.visibleBlocker).toBe(true);
  });

  it('honors skipStateUpdate rules (transcript viewer)', () => {
    const m = manifest([
      rule({
        id: 'viewer',
        state: 'unknown',
        priority: 1000,
        skipStateUpdate: true,
        contains: ['showing detailed transcript'],
      }),
    ]);
    const result = detectAgentState(m, input('showing detailed transcript · ctrl+o to toggle'));
    expect(result.skipStateUpdate).toBe(true);
    expect(result.matchedRuleId).toBe('viewer');
  });

  it('detects working from an osc_title spinner rule', () => {
    const m = manifest([
      rule({
        id: 'spin',
        state: 'working',
        region: 'osc_title',
        visibleWorking: true,
        regex: [/^[\u{2800}-\u{28FF}] /u],
      }),
    ]);
    const result = detectAgentState(m, input('', '⠉ Claude'));
    expect(result.state).toBe('working');
    expect(result.visibleWorking).toBe(true);
  });
});
