import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { choiceStep, highlightedAnswer, highlightOf, initialHighlight, isChoiceEnter, stepHighlight, type ChoiceKeyPress } from './choiceCursor';

// Node has no DOM: an element with the fields the typing check reads.
class FakeElement extends EventTarget {
  constructor(readonly tagName: string, readonly isContentEditable = false) { super(); }
  closest(): null { return null; }
}
const element = (tag: string, editable = false): EventTarget => new FakeElement(tag.toUpperCase(), editable);
beforeEach(() => vi.stubGlobal('HTMLElement', FakeElement));
afterEach(() => vi.unstubAllGlobals());

const press = (key: string, extra: Partial<ChoiceKeyPress> = {}): ChoiceKeyPress => ({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, target: null, ...extra });

describe('choiceStep (T-113)', () => {
  it('J is next and K is previous', () => {
    expect(choiceStep(press('j'))).toBe(1);
    expect(choiceStep(press('k'))).toBe(-1);
    // Caps Lock: a capital with no ⇧ held.
    expect(choiceStep(press('J'))).toBe(1);
  });

  it('ignores other keys, chords with ⌘/Ctrl/⌥/⇧, and composing', () => {
    expect(choiceStep(press('l'))).toBeNull();
    expect(choiceStep(press('ArrowDown'))).toBeNull();
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const) expect(choiceStep(press('j', { [modifier]: true }))).toBeNull();
    expect(choiceStep(press('j', { isComposing: true }))).toBeNull();
  });

  it('never takes a key typed in a text field', () => {
    for (const tag of ['input', 'textarea', 'select']) expect(choiceStep(press('j', { target: element(tag) }))).toBeNull();
    expect(choiceStep(press('k', { target: element('div', true) }))).toBeNull();
    expect(choiceStep(press('j', { target: element('button') }))).toBe(1);
  });
});

describe('isChoiceEnter (T-113)', () => {
  it('a plain Enter outside a text field', () => {
    expect(isChoiceEnter(press('Enter', { target: element('button') }))).toBe(true);
    expect(isChoiceEnter(press('Enter', { target: element('textarea') }))).toBe(false);
    // ⇧↩ is the recommended options and ⌘↩ the send command: not this.
    expect(isChoiceEnter(press('Enter', { shiftKey: true }))).toBe(false);
    expect(isChoiceEnter(press('Enter', { metaKey: true }))).toBe(false);
    expect(isChoiceEnter(press('Enter', { isComposing: true }))).toBe(false);
  });
});

describe('the highlight (T-113)', () => {
  const choices = [{ label: 'A' }, { label: 'B', recommended: true }, { label: 'C' }];

  it('starts on the recommended choice, else the first, so Enter equals ⇧↩', () => {
    expect(initialHighlight(choices)).toBe(1);
    expect(initialHighlight([{ recommended: false }, {}])).toBe(0);
    expect(initialHighlight([])).toBe(-1);
  });

  it('follows the person\'s pick', () => {
    expect(highlightOf(2, choices)).toBe(2);
    expect(highlightOf(-1, choices)).toBe(1);
  });

  it('moves one step and stops at the ends, never wrapping', () => {
    expect(stepHighlight(1, 3, 1)).toBe(2);
    expect(stepHighlight(2, 3, 1)).toBe(2);
    expect(stepHighlight(1, 3, -1)).toBe(0);
    expect(stepHighlight(0, 3, -1)).toBe(0);
    // From nowhere: J the first, K the last.
    expect(stepHighlight(-1, 3, 1)).toBe(0);
    expect(stepHighlight(-1, 3, -1)).toBe(2);
    expect(stepHighlight(0, 0, 1)).toBe(-1);
  });

  it('Enter on several questions sends each pick, else each highlight', () => {
    const questions = [{ choices }, { choices: [{ label: 'Yes' }, { label: 'No' }] }];
    expect(highlightedAnswer(questions, [], [])).toEqual(['B', 'Yes']);
    expect(highlightedAnswer(questions, ['', 'No'], [0, 0])).toEqual(['A', 'No']);
    expect(highlightedAnswer([{ choices: [] }], [], [])).toEqual(['']);
  });
});
