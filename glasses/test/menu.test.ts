import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findMenu } from '../src/menu';

/** A screen captured from a real agent with a headless terminal, 100×40. */
const captured = (name: string) => readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8').split('\n');

describe('a menu on screen', () => {
  it('is found in a Claude permission prompt, with a choice that wraps onto a second row', () => {
    expect(findMenu(captured('claude-permission'))).toEqual({
      choices: ['1. Yes', '2. Yes, and always allow access to /Users/me/code/demo from this', '3. Yes, and switch to auto mode · auto mode handles these prompts for you', '4. No'],
      cursor: 0,
      question: ['Do you want to proceed?'],
    });
  });

  it('is found in a Claude question with a description under each choice and one more choice below a rule', () => {
    expect(findMenu(captured('claude-question'))).toEqual({
      choices: ['1. Red', '2. Blue', '3. Type something.', '4. Chat about this'],
      cursor: 0,
      question: ['☐ Color', 'Which color do you prefer?'],
    });
  });

  it('is found in a Codex approval, and in its folder trust prompt', () => {
    expect(findMenu(captured('codex-approval'))).toEqual({
      choices: ['1. Yes, proceed (y)', "2. Yes, and don't ask again for commands that start with `touch codex.txt` (p)", '3. No, and tell Codex what to do differently (esc)'],
      cursor: 0,
      question: ['Would you like to run the following command?', 'Environment: local', 'Reason: Allow creating codex.txt in the current directory?', '$ touch codex.txt'],
    });
    expect(findMenu(captured('codex-trust'))?.choices).toEqual(['1. Trust and continue', '2. Back to Agent Command Center']);
  });

  it('follows the cursor to another row', () => {
    const screen = captured('claude-permission').map((row) => row.replace(' ❯ 1. Yes', '   1. Yes').replace('   4. No', ' ❯ 4. No'));
    expect(findMenu(screen)?.cursor).toBe(3);
  });

  it('is found with a bulleted list and a > cursor', () => {
    expect(findMenu(['Pick a branch:', '  - main', '> - next', '  - release', '', 'enter to switch'])).toEqual({
      choices: ['- main', '- next', '- release'],
      cursor: 1,
      question: ['Pick a branch:'],
    });
  });
});

describe('no menu', () => {
  const claudeIdle = captured('claude-idle');

  it('on an agent at rest, Claude or Codex', () => {
    expect(findMenu(claudeIdle)).toBeNull();
    expect(findMenu(captured('codex-idle'))).toBeNull();
  });

  it('for a menu whose choices carry no number or bullet', () => {
    expect(findMenu(captured('claude-trust'))).toBeNull();
  });

  it('for a numbered list in an agent\'s prose', () => {
    const prose = ['⏺ Two ways to fix it:', '  1. Stub the clock', '  2. Loosen the retry window', '', '✻ Done'];
    expect(findMenu(prose)).toBeNull();
    // Above Claude's input box, whose prompt carries a cursor mark of its own.
    expect(findMenu([...prose, ...claudeIdle.slice(-4)])).toBeNull();
  });

  it('for a menu with no cursor mark, or two', () => {
    const permission = captured('claude-permission');
    expect(findMenu(permission.map((row) => row.replace(' ❯ 1. Yes', '   1. Yes')))).toBeNull();
    expect(findMenu(permission.map((row) => row.replace('   4. No', ' ❯ 4. No')))).toBeNull();
  });

  it('for a list whose numbering skips', () => {
    expect(findMenu(['Pick one', '❯ 1. Yes', '  2. Maybe', '  4. No', '', 'Esc to cancel'])).toBeNull();
  });

  it('for a list that does not start at 1, or has one choice', () => {
    expect(findMenu(['Pick one', '❯ 2. Yes', '  3. No'])).toBeNull();
    expect(findMenu(['Pick one', '❯ 1. Yes', '', 'Esc to cancel'])).toBeNull();
  });

  it('for a menu scrolled above more output', () => {
    const permission = captured('claude-permission');
    expect(findMenu([...permission, '⏺ Bash(touch bye.txt)', '  ⎿  (No output)', '', '⏺ Done: bye.txt exists.', '', '✻ Worked for 3s'])).toBeNull();
  });

  it('for a shell select menu, which has no cursor', () => {
    expect(findMenu(['$ ./deploy.sh', '1) staging', '2) production', '3) quit', '#? '])).toBeNull();
  });

  it('for bullets with different markers', () => {
    expect(findMenu(['Pick one', '❯ - main', '  * next'])).toBeNull();
  });
});
