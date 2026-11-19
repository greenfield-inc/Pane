import { describe, expect, it } from 'vitest';
import { recallTodoView, rememberTodoView, restoreActiveTab } from './todoPageView';
import type { TodoSplitState } from './splitTabs';

const split: TodoSplitState = {
  all: [{ kind: 'overview', sessionId: 's-1' }],
  extras: [{ kind: 'image', src: 'a.png', label: 'a.png' }],
  closed: [],
  items: [{ kind: 'image', src: 'a.png', label: 'a.png' }, { kind: 'overview', sessionId: 's-1' }],
  active: 0,
  hidden: false,
  reveal: null,
};

describe('to-do page view memory', () => {
  it('recalls the tab and scroll a to-do was left on, per machine and number', () => {
    rememberTodoView('local:1', { tab: 'overview:s-1', pageScroll: 165, splitScroll: 40 });
    expect(recallTodoView('local:1')).toEqual({ tab: 'overview:s-1', pageScroll: 165, splitScroll: 40 });
    expect(recallTodoView('local:2')).toBeNull();
    expect(recallTodoView('devbox:1')).toBeNull();
  });

  it('reselects the remembered tab when it still exists', () => {
    expect(restoreActiveTab(split, 'overview:s-1').active).toBe(1);
  });

  it('keeps the default tab when the remembered one is gone or there is none', () => {
    expect(restoreActiveTab(split, 'attachment:9')).toBe(split);
    expect(restoreActiveTab(split, null)).toBe(split);
  });
});
