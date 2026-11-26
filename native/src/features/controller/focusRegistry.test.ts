import { describe, expect, it } from 'vitest';

import { createFocusRegistry, type Rect } from './focusRegistry';

/** A control at a fixed spot on a 400-wide screen. */
function control(id: string, rect: Rect, extra: { scope?: string; preferred?: boolean; onEdge?: () => boolean } = {}) {
  const activated: string[] = [];
  return {
    activated,
    item: { id, scope: extra.scope ?? '', measure: () => rect, activate: () => void activated.push(id), ...extra },
  };
}

const row = (y: number) => ({ x: 0, y, width: 400, height: 60 });

describe('focus registry', () => {
  it('starts on the top control and walks a list down and up', () => {
    const focus = createFocusRegistry();
    for (const [id, y] of [['first', 100], ['second', 160], ['third', 220]] as const) focus.add(control(id, row(y)).item);
    expect(focus.move('down')).toBe('moved');
    expect(focus.focused()?.id).toBe('first');
    focus.move('down');
    focus.move('down');
    expect(focus.focused()?.id).toBe('third');
    focus.move('up');
    expect(focus.focused()?.id).toBe('second');
  });

  it('asks the list to scroll at its last mounted row', () => {
    const focus = createFocusRegistry();
    let scrolled = 0;
    focus.add(control('last', row(700), { onEdge: () => ++scrolled > 0 }).item);
    focus.move('down');
    expect(focus.move('down')).toBe('scrolled');
    expect(scrolled).toBe(1);
  });

  it('keeps focus inside the newest scope and lands on its recommended option', () => {
    const focus = createFocusRegistry();
    focus.add(control('home-row', row(100)).item);
    focus.move('down');
    const close = focus.openScope({ key: 'sheet' });
    focus.add(control('deny', row(500), { scope: 'sheet' }).item);
    focus.add(control('allow', row(560), { scope: 'sheet', preferred: true }).item);
    expect(focus.focused()).toBeNull();
    focus.move('up');
    expect(focus.focused()?.id).toBe('allow');
    focus.move('up');
    expect(focus.focused()?.id).toBe('deny');
    close();
    expect(focus.activeScope()).toBe('');
  });

  it('runs A on the focused control only', () => {
    const focus = createFocusRegistry();
    const open = control('open', row(100));
    focus.add(open.item);
    expect(focus.activate()).toBe(false);
    focus.move('down');
    expect(focus.activate()).toBe(true);
    expect(open.activated).toEqual(['open']);
  });

  it('ignores A while the focused control is off screen (below a half-height sheet)', () => {
    const focus = createFocusRegistry();
    let onScreen = true;
    const activated: string[] = [];
    focus.add({ id: 'allow', scope: '', measure: () => (onScreen ? row(500) : null), activate: () => void activated.push('allow') });
    focus.move('down');
    onScreen = false;
    expect(focus.activate()).toBe(false);
    expect(activated).toEqual([]);
  });

  it('drops focus when the focused control unmounts', () => {
    const focus = createFocusRegistry();
    const remove = focus.add(control('gone', row(100)).item);
    focus.move('down');
    remove();
    expect(focus.focused()).toBeNull();
  });
});
