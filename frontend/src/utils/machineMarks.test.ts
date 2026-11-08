import { describe, expect, it } from 'vitest';
import {
  assignMachineLetters,
  machineMarkKey,
  normalizeMarkLetters,
  resolveMachineMark,
} from '../../../shared/utils/machineMarks';

describe('machine letters', () => {
  it('gives each machine its first letter, upper-cased, when no other machine shares it', () => {
    expect(assignMachineLetters(['studio-mac', 'build-box', 'parsa-devbox', 'travel-laptop'])).toEqual(new Map([
      ['studio-mac', 'S'],
      ['build-box', 'B'],
      ['parsa-devbox', 'P'],
      ['travel-laptop', 'T'],
    ]));
  });

  it('gives two letters to every machine whose first letter is shared, starting with the next word', () => {
    const letters = assignMachineLetters(['travel-laptop', 'test-box', 'studio-mac']);
    expect(letters.get('travel-laptop')).toBe('TL');
    expect(letters.get('test-box')).toBe('TB');
    expect(letters.get('studio-mac')).toBe('S');
  });

  it('keeps shared-letter machines distinct when their second words start alike', () => {
    const letters = assignMachineLetters(['build-box', 'backup-box']);
    expect(letters.get('backup-box')).not.toBe(letters.get('build-box'));
    expect(letters.get('backup-box')).toMatch(/^B.$/);
    expect(letters.get('build-box')).toMatch(/^B.$/);
  });

  it('does not depend on the order the names arrive in', () => {
    const names = ['build-box', 'backup-box', 'bastion'];
    expect(new Map([...assignMachineLetters([...names].reverse())].sort())).toEqual(new Map([...assignMachineLetters(names)].sort()));
  });

  it('treats letters case-insensitively and skips leading symbols', () => {
    const letters = assignMachineLetters(['Studio', '_staging', 'This computer']);
    expect(letters.get('Studio')).toMatch(/^S.$/);
    expect(letters.get('_staging')).toMatch(/^S.$/);
    expect(letters.get('Studio')).not.toBe(letters.get('_staging'));
    expect(letters.get('This computer')).toBe('T');
  });

  it('still keeps machines distinct when the name runs out of letters', () => {
    const letters = assignMachineLetters(['a', 'aa', 'a-a']);
    expect(new Set(letters.values()).size).toBe(3);
  });

  it('marks a name with no letters or digits with a question mark', () => {
    expect(assignMachineLetters(['---']).get('---')).toBe('?');
  });
});

describe('letter field', () => {
  it('keeps one or two letters or digits, upper-cased', () => {
    expect(normalizeMarkLetters(' t ')).toBe('T');
    expect(normalizeMarkLetters('mb')).toBe('MB');
    expect(normalizeMarkLetters('m-b-x')).toBe('MB');
    expect(normalizeMarkLetters('42')).toBe('42');
  });

  it('is empty for nothing usable', () => {
    expect(normalizeMarkLetters('')).toBe('');
    expect(normalizeMarkLetters(' - ')).toBe('');
  });
});

describe('mark overrides', () => {
  it('keys this computer as local and every other machine by its name', () => {
    expect(machineMarkKey({ id: 'local', name: 'studio-mac' })).toBe('local');
    expect(machineMarkKey({ id: 'tailnet:build-box.tail1234.ts.net', name: 'build-box' })).toBe('build-box');
    expect(machineMarkKey({ id: 'tailnet-tail1234.ts.net-build-box', name: 'build-box' })).toBe('build-box');
  });

  it('uses the automatic letters and colour without an override', () => {
    expect(resolveMachineMark({ letters: 'T', slot: 2 }, undefined)).toEqual({ letters: 'T', slot: 2, custom: false });
  });

  it('applies a saved letter and colour', () => {
    expect(resolveMachineMark({ letters: 'T', slot: 2 }, { letters: 'tl', color: 'Lime' })).toEqual({ letters: 'TL', slot: 3, custom: true });
  });

  it('applies just the part that was saved', () => {
    expect(resolveMachineMark({ letters: 'T', slot: 2 }, { color: 'Violet' })).toEqual({ letters: 'T', slot: 0, custom: true });
    expect(resolveMachineMark({ letters: 'T', slot: 2 }, { letters: 'X' })).toEqual({ letters: 'X', slot: 2, custom: true });
  });

  it('ignores a saved value it cannot use', () => {
    // SAFETY: a hand-edited config can hold any string; the cast only lets the test pass one.
    expect(resolveMachineMark({ letters: 'T', slot: 2 }, { letters: '--', color: 'Plaid' as 'Lime' })).toEqual({ letters: 'T', slot: 2, custom: false });
  });
});
