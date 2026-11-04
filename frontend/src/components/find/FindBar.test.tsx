import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FindBar, FindBarView } from './FindBar';
import { NO_TEXT_MESSAGE, findBarControlKeyAction, findBarKeyAction, findCountLabel } from './findBarLogic';
import { getFindBar, openFind, registerFindTarget, resetFindForTests, setFindQuery, type FindAdapter, type FindMode } from './findController';

function adapter(mode: FindMode, total: number): FindAdapter {
  return {
    mode: () => mode,
    search: () => ({ current: total ? 1 : 0, total }),
    step: () => ({ current: 1, total }),
    clear: () => {},
  };
}

describe('FindBar', () => {
  beforeEach(() => resetFindForTests());

  it('renders nothing while closed', () => {
    registerFindTarget('t', { adapter: adapter('text', 3), root: () => null });
    expect(renderToStaticMarkup(<FindBar panelId="t" />)).toBe('');
  });

  it('shows an empty Find input with no count before typing', () => {
    registerFindTarget('t', { adapter: adapter('text', 3), root: () => null });
    openFind('t');
    const html = renderToStaticMarkup(<FindBarView panelId="t" bar={getFindBar('t')} />);
    expect(html).toContain('placeholder="Find"');
    expect(html).not.toContain(' of ');
  });

  it('shows "1 of 12" once matches are found', () => {
    registerFindTarget('t', { adapter: adapter('text', 12), root: () => null });
    openFind('t');
    setFindQuery('t', 'needle');
    expect(renderToStaticMarkup(<FindBarView panelId="t" bar={getFindBar('t')} />)).toContain('1 of 12');
  });

  it('shows "0 of 0" and the warning tint when nothing matches', () => {
    registerFindTarget('t', { adapter: adapter('text', 0), root: () => null });
    openFind('t');
    setFindQuery('t', 'zzz');
    const html = renderToStaticMarkup(<FindBarView panelId="t" bar={getFindBar('t')} />);
    expect(html).toContain('0 of 0');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('bg-status-warning/15');
  });

  it('says there is no text to search in an image tab', () => {
    registerFindTarget('img', { adapter: adapter('none', 0), root: () => null });
    openFind('img');
    const html = renderToStaticMarkup(<FindBarView panelId="img" bar={getFindBar('img')} />);
    expect(html).toContain(NO_TEXT_MESSAGE);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('readOnly=""');
  });
});

describe('findBarKeyAction', () => {
  const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, isComposing: false });

  it('maps Enter, Shift+Enter and Esc', () => {
    expect(findBarKeyAction(key('Enter'))).toBe('next');
    expect(findBarKeyAction(key('Enter', true))).toBe('prev');
    expect(findBarKeyAction(key('Escape'))).toBe('close');
    expect(findBarKeyAction(key('a'))).toBeNull();
  });

  it('ignores Enter while an IME is composing', () => {
    expect(findBarKeyAction({ key: 'Enter', shiftKey: false, isComposing: true })).toBeNull();
  });
});

describe('findBarControlKeyAction', () => {
  it('closes on Esc from a button and leaves Enter and Space to the button', () => {
    expect(findBarControlKeyAction({ key: 'Escape', isComposing: false })).toBe('close');
    expect(findBarControlKeyAction({ key: 'Enter', isComposing: false })).toBeNull();
    expect(findBarControlKeyAction({ key: ' ', isComposing: false })).toBeNull();
  });
});

describe('findCountLabel', () => {
  it('is blank for an empty query', () => {
    expect(findCountLabel({ query: '', result: { current: 0, total: 0 }, noText: false })).toBe('');
  });
});
