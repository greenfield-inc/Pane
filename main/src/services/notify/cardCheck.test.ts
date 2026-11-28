import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import { assertCard, bareIds, checkCard } from './cardCheck';

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

  it('warns on a long subtitle, no recommendation, too many options and bare options', () => {
    const many = ['A', 'B', 'C', 'D', 'E'].map(label => ({ label }));
    const result = checkCard({ title: 'Which build?', context: `${'Long. '.repeat(45)}See /Users/me/repo/plan.html.`, choices: many });
    // Paths the card names are admission's (cardAdmit.ts): attached, refused or warned about there.
    expect(result.warnings.map(warning => warning.split(' ').slice(0, 3).join(' '))).toEqual([
      'The subtitle is',
      'No option is',
      'A question has',
      'Some options have',
    ]);
  });

  it('warns, without refusing, on a title that names items only by id', () => {
    const result = checkCard({ title: 'Move the 3 overdue security P0s (items 141, 142, 143) from Tue 11/24 to Mon 11/30 in the tracker?', context: subtitle, choices });
    expect(result.refusal).toBeUndefined();
    expect(result.warnings).toEqual([expect.stringMatching(/^The title names items 141, 142, 143 only by id/u)]);
    expect(checkCard({ title: 'Merge #1698 and close F-8?', context: subtitle, choices }).warnings).toEqual([expect.stringContaining('#1698, F-8')]);
  });

  it('takes an id with a description beside it, and the title\'s Q-n prefix, as named', () => {
    for (const title of [
      'Q-12: Revoke staging\'s access to production Spanner?',
      'Merge #1698 (the login timeout fix) today?',
      'Merge the login timeout fix (#1698) today?',
      'Close F-8: the flaky sign-in test, now passing?',
      'Answer Q-12, the Spanner access question, before the release?',
      'Encode the export as UTF-8 and hash it with SHA-256?',
    ]) expect(checkCard({ title, context: subtitle, choices }).warnings, title).toEqual([]);
  });

  it('warns on options, and questions, that name items only by id', () => {
    const bare = [{ label: 'Move items 141, 142', detail: 'They move to Mon 11/30.', recommended: true }, { label: 'Keep them', detail: 'They stay overdue.' }];
    expect(checkCard({ title: 'Reschedule the security fixes?', context: subtitle, choices: bare }).warnings).toEqual([expect.stringMatching(/^Some options name items 141, 142 only by id/u)]);
    const named = [{ label: 'Move them', detail: 'Moves #1698 (the login fix) and F-8 (the flaky test) to Monday.', recommended: true }, { label: 'Keep them', detail: 'They stay overdue.' }];
    expect(checkCard({ title: 'Reschedule the security fixes?', context: subtitle, choices: named }).warnings).toEqual([]);
    const questions = [{ title: 'Close Q-12?', choices }, { title: 'Ship it?', choices: [{ label: 'Ship', detail: 'Ships D-40.', recommended: true }, { label: 'Hold', detail: 'Waits.' }] }];
    expect(checkCard({ title: 'Two questions', context: subtitle, questions }).warnings).toEqual([expect.stringContaining('Q-12, D-40 only by id')]);
  });

  it('finds bare ids: one per id, each list as one', () => {
    expect(bareIds('items 141, 142 and 143, then #9 and #9 again, and PANE-12')).toEqual(['items 141, 142 and 143', '#9', 'PANE-12']);
    expect(bareIds('item 141 (staging access), version 2.5, Tue 11/24, sign-in, P0s, x86-64')).toEqual([]);
  });

  it('throws the refusal as a PaneError with a code and next step', () => {
    expect(() => assertCard({ title: 'x'.repeat(161) })).toThrow(PaneError);
    expect(assertCard({ title: 'Ship it?', context: subtitle })).toEqual([]);
  });
});
