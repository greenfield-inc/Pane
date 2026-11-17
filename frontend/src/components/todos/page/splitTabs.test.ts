import { describe, expect, it } from 'vitest';
import type { TodoAttachment } from '../../../../../shared/types/todos';
import { CLOSED_SPLIT, splitItemKey, todoSplitReducer, type TodoSplitItem, type TodoSplitState } from './splitTabs';

const attachment: TodoAttachment = { id: 4, todoNumber: 12, kind: 'plan', target: '/tmp/plan.html', label: 'Cover sheet r1', addedBy: 'planner', source: 'attached', addedAt: 1 };
const q11: TodoSplitItem = { kind: 'approval', id: 'q11' };
const plan: TodoSplitItem = { kind: 'attachment', attachment };
const image: TodoSplitItem = { kind: 'image', src: 'https://example.test/a.png', label: 'a.png' };

function openAll(...items: TodoSplitItem[]): TodoSplitState {
  return items.reduce((state, item) => todoSplitReducer(state, { type: 'open', item }), CLOSED_SPLIT);
}

describe('todoSplitReducer', () => {
  it('opens items as tabs and shows the newest', () => {
    const state = openAll(q11, plan);
    expect(state.items.map(splitItemKey)).toEqual(['approval:q11', 'attachment:4']);
    expect(state.active).toBe(1);
  });

  it('shows an open item’s tab instead of opening it twice', () => {
    const state = todoSplitReducer(openAll(q11, plan, image), { type: 'open', item: { kind: 'approval', id: 'q11' } });
    expect(state.items).toHaveLength(3);
    expect(state.active).toBe(0);
  });

  it('closing the shown tab shows the one that took its place, or the last', () => {
    const middle = todoSplitReducer({ ...openAll(q11, plan, image), active: 1 }, { type: 'close-active' });
    expect(middle.items.map(splitItemKey)).toEqual(['approval:q11', 'image:https://example.test/a.png']);
    expect(middle.active).toBe(1);
    const last = todoSplitReducer(openAll(q11, plan, image), { type: 'close', index: 2 });
    expect(last.active).toBe(1);
  });

  it('closing a tab before the shown one keeps the same tab shown', () => {
    const state = todoSplitReducer(openAll(q11, plan, image), { type: 'close', index: 0 });
    expect(state.items.map(splitItemKey)[state.active]).toBe('image:https://example.test/a.png');
  });

  it('closing the last tab, or Close split, closes the split', () => {
    expect(todoSplitReducer(openAll(q11), { type: 'close-active' })).toBe(CLOSED_SPLIT);
    expect(todoSplitReducer(openAll(q11, plan), { type: 'close-all' })).toBe(CLOSED_SPLIT);
  });

  it('ignores tabs that are not there', () => {
    const state = openAll(q11);
    expect(todoSplitReducer(state, { type: 'close', index: 5 })).toBe(state);
    expect(todoSplitReducer(state, { type: 'activate', index: -1 })).toBe(state);
    expect(todoSplitReducer(CLOSED_SPLIT, { type: 'close-active' })).toBe(CLOSED_SPLIT);
  });
});
