import type { ChatTurn } from '../../../../shared/chatTabPresentation';

/**
 * Who wrote each reply (T-63 round 5), as a profile ref by turn id: after the last divider, the
 * tab's own profile (`current`); between dividers, the profile the divider before it switched to,
 * else the one the divider after it switched from; before the first, the profile it switched from.
 * A reply that nothing names (a divider saved before dividers named profiles) is left out, so it
 * shows no photo rather than a guessed one.
 *
 * Replies after the last divider take the profile it names; `current` (the tab's own profile)
 * stands in only when no divider names one, because a Switch publishes its launch before the
 * replay brings its divider back. Pass `current` only when the turns reach the live end of the
 * conversation; otherwise undefined.
 */
export function replyAuthors(turns: readonly ChatTurn[], current: string | undefined): Map<string, string> {
  const authors = new Map<string, string>();
  // Walked from the end: each divider says who wrote the replies above it.
  let author = previousSwitchedTo(turns, turns.length) ?? current;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn.divider) {
      author = turn.divider.previous ?? previousSwitchedTo(turns, index);
      continue;
    }
    if (author) authors.set(turn.id, author);
  }
  return authors;
}

/** The profile the divider before `index` switched to, when one says so. */
function previousSwitchedTo(turns: readonly ChatTurn[], index: number): string | undefined {
  for (let earlier = index - 1; earlier >= 0; earlier--) {
    const divider = turns[earlier].divider;
    if (divider) return divider.profile;
  }
  return undefined;
}
