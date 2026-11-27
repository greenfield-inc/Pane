import { describe, expect, it } from 'vitest';
import { isClearCommand, isResumeCommand, menuCommands, RESUME_COMMAND } from './chatCommands';

describe('composer commands', () => {
  it('offers Pane\'s own commands beside the agent\'s, once each', () => {
    const found = menuCommands([{ name: 'resume', description: 'Agent resume' }, { name: 'clear' }, { name: 'review' }], true);
    expect(found.map(command => command.description ?? command.name)).toEqual(['Start a fresh conversation in this tab', 'Continue a past conversation in this folder', 'review']);
    expect(found[1]).toEqual(RESUME_COMMAND);
  });

  it('leaves the agent\'s /clear alone where Pane offers none', () => {
    expect(menuCommands([{ name: 'clear', description: 'agent clear' }], false).map(command => command.name)).toEqual(['resume', 'clear']);
  });

  it('intercepts exactly /resume and /clear, never a message that only mentions one', () => {
    expect(isResumeCommand('/resume')).toBe(true);
    expect(isResumeCommand('  /resume \n')).toBe(true);
    expect(isResumeCommand('/resume abc')).toBe(false);
    expect(isResumeCommand('please /resume')).toBe(false);
    expect(isResumeCommand('/resumes')).toBe(false);
    expect(isClearCommand(' /clear ')).toBe(true);
    expect(isClearCommand('/clear the cache')).toBe(false);
  });
});
