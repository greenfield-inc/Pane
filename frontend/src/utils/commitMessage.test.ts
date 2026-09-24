import { describe, expect, it } from 'vitest';
import {
  composeCommitMessage,
  hasCommitMessageTitle,
  isCommitSubmitShortcut,
  splitCommitMessage,
} from '../../../shared/utils/commitMessage';

describe('commitMessage', () => {
  it('composes a title and description using the conventional blank line separator', () => {
    expect(composeCommitMessage('Add commit title field', 'Explain the change clearly.')).toBe(
      'Add commit title field\n\nExplain the change clearly.',
    );
  });

  it('omits the separator when the optional description is empty', () => {
    expect(composeCommitMessage('Add commit title field', '  ')).toBe('Add commit title field');
  });

  it('splits an existing multiline commit message into title and description', () => {
    expect(splitCommitMessage('Add commit title field\r\n\r\nExplain the change.\r\nKeep existing behavior.')).toEqual({
      title: 'Add commit title field',
      description: 'Explain the change.\nKeep existing behavior.',
    });
  });

  it('supports existing messages without a blank separator', () => {
    expect(splitCommitMessage('Add commit title field\nExplain the change.')).toEqual({
      title: 'Add commit title field',
      description: 'Explain the change.',
    });
  });

  it('requires a non-empty first-line title at process boundaries', () => {
    expect(hasCommitMessageTitle('Commit title\n\nDescription')).toBe(true);
    expect(hasCommitMessageTitle('  \n\nDescription only')).toBe(false);
  });

  it('recognizes enabled, non-repeating modifier-enter submissions', () => {
    const event = { key: 'Enter', ctrlKey: true, metaKey: false, repeat: false };

    expect(isCommitSubmitShortcut(event, true, true)).toBe(true);
    expect(isCommitSubmitShortcut({ ...event, repeat: true }, true, true)).toBe(false);
    expect(isCommitSubmitShortcut(event, false, true)).toBe(false);
    expect(isCommitSubmitShortcut(event, true, false)).toBe(false);
  });
});
