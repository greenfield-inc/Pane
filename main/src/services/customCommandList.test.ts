import { describe, expect, it } from 'vitest';
import { applyCustomCommandEdit, type CustomCommandEdit } from './customCommandList';
import { PaneError } from '../../../shared/paneError';
import type { CustomCommand } from '../types/config';

const build: CustomCommand = { name: 'Build', command: 'pnpm build' };
const lint: CustomCommand = { name: 'lint', command: 'pnpm lint' };
const farm: CustomCommand = {
  name: 'Farm',
  command: 'agent-farm run x',
  resume: { mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} --resume {sessionId}' },
};

/** The refusal an edit throws, or null when it succeeds. */
function refusalOf(current: readonly CustomCommand[], edit: CustomCommandEdit): PaneError | null {
  try {
    applyCustomCommandEdit(current, edit);
  } catch (error) {
    if (error instanceof PaneError) return error;
    throw error;
  }
  return null;
}

function codeOf(current: readonly CustomCommand[], edit: CustomCommandEdit): string | undefined {
  return refusalOf(current, edit)?.code;
}

describe('applyCustomCommandEdit', () => {
  it('appends a new entry and treats names case-sensitively', () => {
    const { list, outcome } = applyCustomCommandEdit([build], { kind: 'add', name: 'build', command: 'make' });
    expect(list).toEqual([build, { name: 'build', command: 'make' }]);
    expect(outcome).toMatchObject({ action: 'added', name: 'build', position: 2, count: 2 });
  });

  it('refuses to add an exact name already in use', () => {
    expect(codeOf([build], { kind: 'add', name: 'Build', command: 'x' })).toBe('ERR_CUSTOM_COMMAND_EXISTS');
  });

  it('refuses a blank name or command', () => {
    expect(codeOf([], { kind: 'add', name: '  ', command: 'x' })).toBe('ERR_CUSTOM_COMMAND_INVALID');
    expect(codeOf([], { kind: 'add', name: 'a', command: ' ' })).toBe('ERR_CUSTOM_COMMAND_INVALID');
  });

  it('fills the default templates when only a resume mode is given', () => {
    const { list } = applyCustomCommandEdit([], { kind: 'add', name: 'Farm', command: 'agent-farm run x', resume: { mode: 'reported' } });
    expect(list[0]).toEqual(farm);
  });

  it('refuses resume settings that fail the existing rules, without echoing the templates', () => {
    const refusal = refusalOf([], { kind: 'add', name: 'G', command: 'gen', resume: { mode: 'generated', initialTemplate: 'secret-canary-1' } });
    expect(refusal?.code).toBe('ERR_CUSTOM_COMMAND_INVALID');
    expect(refusal?.message).toContain('First launch command must contain {sessionId}');
    expect(`${refusal?.message} ${refusal?.next}`).not.toContain('secret-canary-1');
  });

  it('refuses a template without a mode on an entry that has no resume settings', () => {
    expect(codeOf([build], { kind: 'update', name: 'Build', resume: { resumeTemplate: 'x {sessionId}' } })).toBe('ERR_CUSTOM_COMMAND_INVALID');
  });

  it('patches only supplied fields, keeping resume settings unless cleared', () => {
    const renamed = applyCustomCommandEdit([build, farm], { kind: 'update', name: 'Farm', newName: 'Farm 2', command: 'agent-farm run y' });
    expect(renamed.list[1]).toEqual({ ...farm, name: 'Farm 2', command: 'agent-farm run y' });
    const patched = applyCustomCommandEdit([farm], { kind: 'update', name: 'Farm', resume: { resumeTemplate: '{command} -r {sessionId}' } });
    expect(patched.list[0]!.resume).toEqual({ ...farm.resume, resumeTemplate: '{command} -r {sessionId}' });
    const cleared = applyCustomCommandEdit([farm], { kind: 'update', name: 'Farm', resume: null });
    expect(cleared.list[0]).toEqual({ name: 'Farm', command: 'agent-farm run x' });
  });

  it('refuses a rename to a name in use, but allows keeping the same name', () => {
    expect(codeOf([build, lint], { kind: 'update', name: 'lint', newName: 'Build' })).toBe('ERR_CUSTOM_COMMAND_EXISTS');
    expect(applyCustomCommandEdit([build], { kind: 'update', name: 'Build', newName: 'Build' }).list).toEqual([build]);
  });

  it('refuses a missing or mis-cased name and suggests the match', () => {
    const refusal = refusalOf([build], { kind: 'remove', name: 'build' });
    expect(refusal?.code).toBe('ERR_CUSTOM_COMMAND_NOT_FOUND');
    expect(refusal?.next).toContain('"Build"');
  });

  it('lists legacy duplicates but refuses to edit an ambiguous name', () => {
    const twins = [build, { name: 'Build', command: 'make' }];
    const edits: CustomCommandEdit[] = [
      { kind: 'update', name: 'Build', command: 'x' },
      { kind: 'remove', name: 'Build' },
      { kind: 'reorder', name: 'Build', position: 1 },
    ];
    for (const edit of edits) expect(codeOf(twins, edit)).toBe('ERR_CUSTOM_COMMAND_AMBIGUOUS');
  });

  it('removes the selected entry', () => {
    const { list, outcome } = applyCustomCommandEdit([build, lint, farm], { kind: 'remove', name: 'lint' });
    expect(list).toEqual([build, farm]);
    expect(outcome).toMatchObject({ action: 'removed', position: null, previousPosition: 2, count: 2 });
  });

  it('moves an entry to a 1-based final position, shifting the others in order', () => {
    expect(applyCustomCommandEdit([build, lint, farm], { kind: 'reorder', name: 'Build', position: 3 }).list).toEqual([lint, farm, build]);
    expect(applyCustomCommandEdit([build, lint, farm], { kind: 'reorder', name: 'Farm', position: 1 }).list).toEqual([farm, build, lint]);
  });

  it('treats a move to the current position as a successful no-op', () => {
    const { list, outcome } = applyCustomCommandEdit([build, lint], { kind: 'reorder', name: 'lint', position: 2 });
    expect(list).toEqual([build, lint]);
    expect(outcome).toMatchObject({ action: 'moved', changed: false, position: 2, previousPosition: 2 });
  });

  it('refuses positions outside the list', () => {
    for (const position of [0, 3, 1.5]) {
      expect(codeOf([build, lint], { kind: 'reorder', name: 'Build', position })).toBe('ERR_CUSTOM_COMMAND_INVALID');
    }
  });

  it('saves a desktop row edit only while the row still holds what the editor showed', () => {
    const renamed = applyCustomCommandEdit([build, build], { kind: 'row', index: 1, expected: build, next: { ...build, name: 'Build 2' } });
    expect(renamed.list).toEqual([build, { name: 'Build 2', command: 'pnpm build' }]);
    expect(applyCustomCommandEdit([build, lint], { kind: 'row', index: 0, expected: build, next: null }).list).toEqual([lint]);
    // The list was reordered meanwhile: row 0 now holds lint, so the save is refused rather than applied to it.
    expect(codeOf([lint, build], { kind: 'row', index: 0, expected: build, next: null })).toBe('ERR_CUSTOM_COMMAND_CHANGED');
  });
});
