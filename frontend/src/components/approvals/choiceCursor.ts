import { isTypingTarget } from '../../utils/typingTarget';

/**
 * J and K move a highlight between an approval card's choices (T-113), on every surface that shows
 * them: the column (Approvals, a Session's column), the strip and Answer all. One place decides
 * which presses count and where the highlight goes, so the surfaces can't drift apart.
 *
 * The highlight is not a pick (D-385 holds: nothing starts picked). It starts on the recommended
 * choice, else the first, so Enter with no J/K sends what ⇧↩ would. J/K stop at the ends.
 */

/** What a key handler needs to know about a press; a DOM or React keyboard event fits. */
export interface ChoiceKeyPress {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
  isComposing?: boolean;
}

/**
 * +1 for J (next), -1 for K (previous), null for anything else: another key, a chord with
 * ⌘/Ctrl/⌥ (or ⇧, which types a capital), a key typed while composing, or a press in a text field.
 */
export function choiceStep(event: ChoiceKeyPress): 1 | -1 | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return null;
  // Caps Lock reads as J or K without ⇧.
  const key = event.key.toLowerCase();
  if (key !== 'j' && key !== 'k') return null;
  if (isTypingTarget(event.target)) return null;
  return key === 'j' ? 1 : -1;
}

/** A plain Enter, not typed into a field: it sends the highlighted choice. */
export function isChoiceEnter(event: ChoiceKeyPress): boolean {
  return event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing && !isTypingTarget(event.target);
}

/** Where the highlight starts: the recommended choice, else the first. -1 when there are none. */
export function initialHighlight(choices: readonly { recommended?: boolean }[]): number {
  if (choices.length === 0) return -1;
  const recommended = choices.findIndex((choice) => choice.recommended);
  return recommended >= 0 ? recommended : 0;
}

/** The highlight one step on, stopping at the first and last choice (no wrap). */
export function stepHighlight(at: number, count: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (at < 0 || at >= count) return step === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, at + step));
}

/** The highlight shown: the person's pick when there is one, else where it starts. */
export function highlightOf(picked: number, choices: readonly { recommended?: boolean }[]): number {
  return picked >= 0 && picked < choices.length ? picked : initialHighlight(choices);
}

/**
 * What Enter sends on a card with several questions: each question's pick, else its highlighted
 * choice. Empty labels where a question has no choices.
 */
export function highlightedAnswer(questions: readonly { choices: readonly { label: string; recommended?: boolean }[] }[], picks: readonly string[], highlights: readonly number[]): string[] {
  return questions.map((question, at) => {
    if (picks[at]) return picks[at];
    const index = highlights[at] ?? initialHighlight(question.choices);
    return question.choices[index]?.label ?? '';
  });
}
