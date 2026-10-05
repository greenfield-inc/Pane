import { describe, expect, it } from 'vitest';
import { WindowTree, type UiElement } from './tree';

function el(role: string, parent: number | null, extra: Partial<UiElement> = {}): UiElement {
  return { ref: `r${Math.random()}`, role, parent, actions: [], states: [], ...extra };
}

const form = (name: string, extraRows: UiElement[] = []): UiElement[] => [
  el('window', null, { label: 'Sign up' }),
  el('textField', 0, { label: 'Name', value: name, states: ['focused'] }),
  el('button', 0, { label: 'Submit' }),
  ...extraRows,
];

describe('WindowTree', () => {
  it('renders the first read as an indented full tree', () => {
    const tree = new WindowTree();
    tree.update([
      el('window', null, { label: 'Notes' }),
      el('toolbar', 0),
      el('button', 1, { label: 'Bold', actions: ['Show Menu'] }),
      el('textArea', 0, { value: 'line one\nline two' }),
    ]);
    expect(tree.render()).toBe([
      '1 window "Notes"',
      '  2 toolbar',
      '    3 button "Bold" · Secondary Actions: Show Menu',
      '  4 textArea value="line one\\nline two"',
    ].join('\n'));
  });

  it('keeps ids across reads and lists only what changed', () => {
    const tree = new WindowTree();
    tree.update(form(''));
    tree.render();
    tree.update(form('Ada', [el('staticText', 0, { label: 'Saved' })]));
    expect(tree.render()).toBe([
      'Changes since the last read: 1 added, 0 removed, 1 changed.',
      '+ 4 staticText "Saved"',
      '~ 2 textField "Name" value="Ada" (focused) (was "")',
    ].join('\n'));
  });

  it('lists a removed subtree once, and never reuses its ids', () => {
    const tree = new WindowTree();
    tree.update([
      el('window', null),
      el('group', 0, { label: 'Loading' }),
      el('progressIndicator', 1),
      el('staticText', 1, { label: 'Please wait' }),
    ]);
    tree.render();
    tree.update([el('window', null), el('button', 0, { label: 'Done' })]);
    expect(tree.render()).toBe([
      'Changes since the last read: 1 added, 1 removed, 0 changed.',
      '+ 5 button "Done"',
      '- 2 group "Loading" (and 2 inside it)',
    ].join('\n'));
  });

  it('matches elements by role and label before position', () => {
    const tree = new WindowTree();
    tree.update([el('list', null), el('row', 0, { label: 'B' }), el('row', 0, { label: 'C' })]);
    tree.render();
    // A row is inserted at the top: B and C keep their ids, the new row gets a fresh one.
    tree.update([el('list', null), el('row', 0, { label: 'A' }), el('row', 0, { label: 'B' }), el('row', 0, { label: 'C' })]);
    expect(tree.render({ full: true })).toBe(['1 list', '  4 row "A"', '  2 row "B"', '  3 row "C"'].join('\n'));
  });

  it('never moves an id to a different control that only shares its role', () => {
    const tree = new WindowTree();
    tree.update([el('sheet', null), el('button', 0, { label: 'Cancel' }), el('button', 0, { label: 'OK' })]);
    tree.render();
    tree.update([el('sheet', null), el('button', 0, { label: 'Keep' }), el('button', 0, { label: 'Delete' })]);
    expect(tree.has(2)).toBe(false);
    expect(tree.render({ full: true })).toBe(['1 sheet', '  4 button "Keep"', '  5 button "Delete"'].join('\n'));
  });

  it('resolves ids to the latest snapshot handle', () => {
    const tree = new WindowTree();
    tree.update([el('window', null), el('button', 0, { label: 'Go', ref: 'old' })]);
    tree.update([el('window', null), el('button', 0, { label: 'Go', ref: 'new' })]);
    expect(tree.refFor(2)).toBe('new');
    expect(tree.refFor(99)).toBeUndefined();
  });

  it('says so when nothing changed', () => {
    const tree = new WindowTree();
    tree.update(form('x'));
    tree.render();
    tree.update(form('x'));
    expect(tree.render()).toBe('No changes since the last read.');
  });

  it('falls back to the full tree when the diff is longer than the budget', () => {
    const rows = (prefix: string) => Array.from({ length: 40 }, (_, i) => el('cell', 0, { label: `${prefix}${i}`, value: `${prefix}${i}` }));
    const tree = new WindowTree();
    tree.update([el('table', null), ...rows('a')]);
    tree.render();
    tree.update([el('table', null), ...rows('b')]);
    const text = tree.render();
    expect(text.split('\n')[0]).toBe('Too much changed to list; the full tree follows.');
    expect(text.split('\n')).toHaveLength(42);
  });
});
