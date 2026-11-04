import { describe, expect, it } from 'vitest';
import { createShellStartupPromptWatcher } from './shellStartupPrompts';

describe('createShellStartupPromptWatcher', () => {
  it('answers the oh-my-zsh update question even when it arrives in styled pieces', () => {
    const watch = createShellStartupPromptWatcher();

    expect(watch('\x1b[1m[oh-my-zsh] Would you like to update?')).toBeUndefined();
    expect(watch(' [Y/n]\x1b[0m ')).toMatchObject({ name: 'oh-my-zsh-update', answer: 'n' });
  });

  it('answers each question once, so its echo and later output pass through', () => {
    const watch = createShellStartupPromptWatcher();
    watch('[oh-my-zsh] Would you like to update? [Y/n] ');

    expect(watch('n\r\n[oh-my-zsh] Would you like to update? [Y/n] ')).toBeUndefined();
  });

  it('ignores ordinary shell output', () => {
    const watch = createShellStartupPromptWatcher();

    expect(watch('Last login: Tue Oct 14 on ttys001\r\nuser@host repo % ')).toBeUndefined();
  });
});
