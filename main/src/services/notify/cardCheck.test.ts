import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import { assertCard, checkCard } from './cardCheck';

const subtitle = 'The one-day check passed: option A holds. Approving the cover sheet needs this answer.';
const choices = [{ label: 'Keep it', detail: 'They lose only this account’s orgs.', recommended: true }, { label: 'Sign them out', detail: 'Matches today’s docs.' }];

describe('checking an approval card', () => {
  it('accepts a card that keeps the contract, with no warnings', () => {
    expect(checkCard({ title: 'Okta sign-out: keep other orgs’ sessions?', context: subtitle, choices })).toEqual({ warnings: [] });
  });

  it('refuses a title over 160 characters, saying what happened and what to do', () => {
    const result = checkCard({ title: 'x'.repeat(200), context: subtitle, choices });
    expect(result.refusal?.code).toBe('ERR_NOTIFY_TITLE');
    expect(result.refusal?.message).toContain('200 characters');
    expect(result.refusal?.next).toMatch(/--context/u);
  });

  it('refuses a title with a line break', () => {
    expect(checkCard({ title: 'Ship it?\nCI is green.', context: subtitle, choices }).refusal?.code).toBe('ERR_NOTIFY_TITLE');
  });

  it('refuses two recommended options, in choices or in any one question', () => {
    const both = choices.map(choice => ({ ...choice, recommended: true }));
    expect(checkCard({ title: 'Ship it?', context: subtitle, choices: both }).refusal?.code).toBe('ERR_NOTIFY_RECOMMENDED');
    const questions = [{ title: 'First?', choices }, { title: 'Second?', choices: both }];
    const refusal = checkCard({ title: 'Two choices', context: subtitle, questions }).refusal;
    expect(refusal?.code).toBe('ERR_NOTIFY_RECOMMENDED');
    expect(refusal?.message).toContain('Second?');
  });

  it('warns, without refusing, on a 120-character title and a card with no subtitle', () => {
    const result = checkCard({ title: `${'word '.repeat(23)}ok?`, choices });
    expect(result.refusal).toBeUndefined();
    expect(result.warnings).toEqual([
      expect.stringMatching(/^The title is 1\d\d characters/u),
      expect.stringMatching(/^No subtitle/u),
    ]);
  });

  it('warns on a long subtitle, no recommendation, too many options, bare options and unlinked paths', () => {
    const many = ['A', 'B', 'C', 'D', 'E'].map(label => ({ label }));
    const result = checkCard({ title: 'Which build?', context: `${'Long. '.repeat(45)}See /Users/me/repo/plan.html.`, choices: many });
    expect(result.warnings.map(warning => warning.split(' ').slice(0, 3).join(' '))).toEqual([
      'The subtitle is',
      'No option is',
      'A question has',
      'Some options have',
      'These paths aren’t',
    ]);
  });

  it('does not warn about a path that is linked', () => {
    const result = checkCard({ title: 'Approve the plan?', context: 'Cover sheet r2 at /b/cover-sheet.html is ready.', choices, links: [{ label: 'Cover sheet', path: '/b/cover-sheet.html' }] });
    expect(result.warnings).toEqual([]);
  });

  it('throws the refusal as a PaneError with a code and next step', () => {
    expect(() => assertCard({ title: 'x'.repeat(161) })).toThrow(PaneError);
    expect(assertCard({ title: 'Ship it?', context: subtitle })).toEqual([]);
  });
});
