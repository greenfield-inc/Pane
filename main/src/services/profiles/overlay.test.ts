import { describe, expect, it } from 'vitest';
import { mergeOverlay, parseExtends, satisfiesRange } from '../../../../shared/profiles/overlay';

describe('parseExtends', () => {
  it('reads name@range, and a bare name as any version', () => {
    expect(parseExtends('greenfield@^1.0')).toEqual({ name: 'greenfield', range: '^1.0' });
    expect(parseExtends('greenfield')).toEqual({ name: 'greenfield', range: '*' });
    expect(parseExtends('Not A Name@1')).toBeUndefined();
  });
});

describe('satisfiesRange', () => {
  it.each([
    ['1.4.2', '^1.0', true],
    ['2.0.0', '^1.0', false],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['1.2.9', '~1.2', true],
    ['1.3.0', '~1.2', false],
    ['1.9.0', '1.x', true],
    ['2.0.0', '1', false],
    ['1.0.0', '1.0.0', true],
    ['1.0.1', '1.0.0', false],
    ['3.1.0', '>=2.0.0', true],
    ['1.9.9', '<2', true],
    ['5.0.0', '*', true],
    ['not-semver', '*', false],
    // Partial bounds and prereleases, as npm's semver package answers them.
    ['1.2.5', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['1.5.0', '>1', false],
    ['2.0.0', '>1', true],
    ['1.2.9', '=1.2', true],
    ['1.1.0-beta.1', '^1.0', false],
    ['1.1.0-beta.1', '*', false],
    ['1.1.0-beta.1', '1.1.0-beta.1', true],
  ])('%s in %s → %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });
});

describe('mergeOverlay', () => {
  it('merges agents and steps key by key, replaces runs, and removes null keys', () => {
    const base = {
      name: 'base', version: '1.0.0',
      agents: { a: { runs: 'x/1', reads: ['r'] }, b: { runs: 'y' } },
      flow: { start: 's', s: { run: 'true' }, t: { run: 'false' } },
      samples: { s: { ok: ['1', '2'], no: ['3', '4'] } },
      runs: { A: ['s'] },
    };
    const merged = mergeOverlay(base, {
      name: 'mine', extends: 'base',
      agents: { a: { runs: 'z/2' }, b: null },
      flow: { t: null },
      samples: { s: { no: ['5', '6'] } },
      runs: { A: ['t'] },
    });
    expect(merged).toEqual({
      name: 'mine', version: '1.0.0', extends: 'base',
      agents: { a: { runs: 'z/2', reads: ['r'] } },
      flow: { start: 's', s: { run: 'true' } },
      samples: { s: { ok: ['1', '2'], no: ['5', '6'] } },
      runs: { A: ['t'] },
    });
  });
});
