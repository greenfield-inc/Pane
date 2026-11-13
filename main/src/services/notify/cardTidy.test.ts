import { describe, expect, it } from 'vitest';
import { tidyCard } from './cardTidy';
import { checkCard } from './cardCheck';

/** Q-42 as it was sent: one --question holding the title, two questions, their recommendations and two files. */
const q42 = "Q-42: Okta sign-out rework (option A holds; cover sheet ready for approval). 1) With Require SSO off, should a person Okta removes keep a password session for their other orgs? Recommended: yes, they keep it and lose the account's orgs; docs stop saying 'signs them out on every device'. 2) Should Require SSO end password sessions for everyone on the domain (same as sign-in, recommended) or only the account's members? Files: /Users/tb/repos/bloom-mono/worktrees/okta-sso-account/tmp/greenfield/okta-signout-rework/decisions.html#q-42, /Users/tb/repos/bloom-mono/worktrees/okta-sso-account/tmp/greenfield/okta-signout-rework/cover-sheet.html";
const q42Context = 'One-day check done: option A holds (5/5 pass, 2 with caveats absorbed by the plan). Cover sheet r1 ready for approval; approval needs Q-42.';

/** Every word of the tidied card, so a test can prove none was added. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

describe('tidying an old paragraph card', () => {
  it('splits Q-42 into a short title, two questions with buttons and two links', () => {
    const tidied = tidyCard({ title: q42, context: q42Context });
    expect(tidied?.card.title).toBe('Q-42: Okta sign-out rework (option A holds; cover sheet ready for approval)');
    expect(tidied?.card.context).toBe(q42Context);
    expect(tidied?.card.questions).toEqual([
      {
        title: 'With Require SSO off, should a person Okta removes keep a password session for their other orgs?',
        choices: [
          { label: 'Yes', detail: "they keep it and lose the account's orgs; docs stop saying 'signs them out on every device'", recommended: true },
          { label: 'No' },
        ],
      },
      {
        title: "Should Require SSO end password sessions for everyone on the domain or only the account's members?",
        choices: [
          { label: 'Everyone on the domain', detail: 'same as sign-in', recommended: true },
          { label: "Only the account's members" },
        ],
      },
    ]);
    expect(tidied?.card.links).toEqual([
      { label: 'decisions.html', path: '/Users/tb/repos/bloom-mono/worktrees/okta-sso-account/tmp/greenfield/okta-signout-rework/decisions.html#q-42' },
      { label: 'cover-sheet.html', path: '/Users/tb/repos/bloom-mono/worktrees/okta-sso-account/tmp/greenfield/okta-signout-rework/cover-sheet.html' },
    ]);
    expect(tidied?.asSent).toEqual({ title: q42, context: q42Context });
    expect(checkCard(tidied!.card).refusal).toBeUndefined();
  });

  it('adds no word that was not sent, beyond the Yes and No a yes-or-no question offers', () => {
    const tidied = tidyCard({ title: q42, context: q42Context })!;
    const sent = new Set(words(`${q42} ${q42Context}`));
    const shown = [tidied.card.title, tidied.card.context ?? '', ...(tidied.card.questions ?? []).flatMap(q => [q.title, ...q.choices.flatMap(c => [c.label, c.detail ?? ''])]), ...(tidied.card.links ?? []).map(l => l.label)].join(' ');
    expect(words(shown).filter(word => !sent.has(word))).toEqual(['no']);
  });

  it('turns "A or B (recommended)" in a single question into choices', () => {
    const tidied = tidyCard({ title: 'Release notes are drafted, the changelog is reviewed and CI is green on main for every platform we ship. Ship the release tonight (recommended) or wait for the Intel build?' });
    expect(tidied?.card).toEqual({
      title: 'Release notes are drafted, the changelog is reviewed and CI is green on main for every platform we ship',
      context: 'Ship the release tonight or wait for the Intel build?',
      choices: [{ label: 'Ship the release tonight', recommended: true }, { label: 'Wait for the Intel build' }],
    });
  });

  it('leaves a well-formed card alone, and a long one it cannot split cleanly', () => {
    expect(tidyCard({ title: 'Ship the release tonight?', context: 'CI is green.' })).toBeUndefined();
    expect(tidyCard({ title: 'x'.repeat(200) })).toBeUndefined();
    expect(tidyCard({ title: 'Ship it?\nCI is green and the notes are drafted.' })).toBeUndefined();
    expect(tidyCard({ title: `${'A long sentence about the plan that keeps going. '.repeat(4)}What now?` })).toBeUndefined();
  });

  it('leaves a card that already has buttons alone', () => {
    expect(tidyCard({ title: q42, choices: [{ label: 'Ok' }] })).toBeUndefined();
  });
});
