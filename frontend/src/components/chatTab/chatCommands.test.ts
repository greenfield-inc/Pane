import { describe, expect, it } from 'vitest';
import { isResumeCommand, matchingCommands, RESUME_COMMAND } from './chatCommands';

describe('composer commands', () => {
  it('offers Pane\'s /resume, labelled Pane, beside the agent\'s commands', () => {
    expect(RESUME_COMMAND).toEqual({ name: 'resume', description: 'Continue a past conversation in this folder', source: 'pane' });
    const found = matchingCommands('/re', [{ name: 'review', description: 'Review a PR' }]);
    expect(found.map(command => command.name)).toEqual(['resume', 'review']);
    expect(found[0].source).toBe('pane');
    expect(found[1].source).toBeUndefined();
  });

  it('lists /resume once even when the agent offers one too, as Pane\'s', () => {
    const found = matchingCommands('/resume', [{ name: 'resume', description: 'Agent resume' }]);
    expect(found).toEqual([RESUME_COMMAND]);
  });

  it('shows nothing once the draft is more than a command name', () => {
    expect(matchingCommands('/resume now', [])).toEqual([]);
    expect(matchingCommands('hello', [])).toEqual([]);
  });

  it('intercepts exactly /resume, never a message that only mentions it', () => {
    expect(isResumeCommand('/resume')).toBe(true);
    expect(isResumeCommand('  /resume \n')).toBe(true);
    expect(isResumeCommand('/resume abc')).toBe(false);
    expect(isResumeCommand('please /resume')).toBe(false);
    expect(isResumeCommand('/resumes')).toBe(false);
  });
});
