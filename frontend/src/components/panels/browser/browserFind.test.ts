import { describe, expect, it } from 'vitest';
import type { FindResult } from '../../find/findController';
import { createBrowserFindAdapter, type BrowserFindDeps, type FindableWebview } from './browserFind';

function setup(overrides: Partial<BrowserFindDeps> = {}) {
  const calls: string[] = [];
  const reports: FindResult[] = [];
  let nextId = 1;
  let inputFocused = true;
  const webview: FindableWebview = {
    findInPage(text, options) {
      calls.push(`find:${text}:${options?.findNext ? 'new' : options?.forward ? 'next' : 'prev'}`);
      // Electron moves focus into the page on every request.
      inputFocused = false;
      return nextId++;
    },
    stopFindInPage(action) { calls.push(`stop:${action}`); },
    focus() { calls.push('focus-page'); },
  };
  const adapter = createBrowserFindAdapter({
    getWebview: () => webview,
    isReady: () => true,
    hasPage: () => true,
    report: result => reports.push(result),
    findInputHasFocus: () => inputFocused,
    focusFindInput: () => { inputFocused = true; calls.push('focus-input'); },
    ...overrides,
  });
  return { adapter, calls, reports, isInputFocused: () => inputFocused };
}

describe('browser find adapter', () => {
  it('starts a new find session and reports the final "1 of 7"', () => {
    const { adapter, calls, reports } = setup();

    expect(adapter.search('needle')).toBeUndefined();
    adapter.handleFoundInPage({ requestId: 1, activeMatchOrdinal: 1, matches: 7, finalUpdate: false });
    adapter.handleFoundInPage({ requestId: 1, activeMatchOrdinal: 1, matches: 7, finalUpdate: true });

    expect(calls[0]).toBe('find:needle:new');
    expect(reports).toEqual([{ current: 1, total: 7 }]);
  });

  it('keeps keyboard focus in the find input while typing', () => {
    const { adapter, isInputFocused } = setup();
    adapter.search('n');
    expect(isInputFocused()).toBe(true);
    adapter.search('ne');
    expect(isInputFocused()).toBe(true);
  });

  it('does not pull focus into the bar when the search came from the page', () => {
    let focused = false;
    const { adapter, calls } = setup({ findInputHasFocus: () => focused, focusFindInput: () => { focused = true; } });
    adapter.search('needle');
    expect(focused).toBe(false);
    expect(calls).not.toContain('focus-input');
  });

  it('ignores results from an older request', () => {
    const { adapter, reports } = setup();
    adapter.search('ne');
    adapter.search('needle');
    adapter.handleFoundInPage({ requestId: 1, activeMatchOrdinal: 1, matches: 20, finalUpdate: true });
    adapter.handleFoundInPage({ requestId: 2, activeMatchOrdinal: 1, matches: 7, finalUpdate: true });
    expect(reports).toEqual([{ current: 1, total: 7 }]);
  });

  it('steps forward and backward within the session', () => {
    const { adapter, calls } = setup();
    adapter.search('needle');
    adapter.step('next');
    adapter.step('prev');
    expect(calls.filter(c => c.startsWith('find:'))).toEqual(['find:needle:new', 'find:needle:next', 'find:needle:prev']);
  });

  it('reports 0 of 0 when nothing matches', () => {
    const { adapter, reports } = setup();
    adapter.search('zzz');
    adapter.handleFoundInPage({ requestId: 1, activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
    expect(reports).toEqual([{ current: 0, total: 0 }]);
  });

  it('clears the highlights and drops late results after closing', () => {
    const { adapter, calls, reports } = setup();
    adapter.search('needle');
    adapter.clear();
    adapter.handleFoundInPage({ requestId: 1, activeMatchOrdinal: 1, matches: 7, finalUpdate: true });
    expect(calls).toContain('stop:clearSelection');
    expect(reports).toEqual([]);
  });

  it('answers 0 of 0 until the page is ready', () => {
    const { adapter, calls } = setup({ isReady: () => false });
    expect(adapter.search('needle')).toEqual({ current: 0, total: 0 });
    expect(calls).toEqual([]);
  });

  it('says there is nothing to search while no page is shown', () => {
    expect(setup({ hasPage: () => false }).adapter.mode()).toBe('none');
    expect(setup().adapter.mode()).toBe('text');
  });

  it('returns focus to the page on close', () => {
    const { adapter, calls } = setup();
    adapter.restoreFocus?.();
    expect(calls).toContain('focus-page');
  });
});

describe('browser find adapter: repeated searches', () => {
  it('ends the previous session before starting a new one, so a re-run starts over', () => {
    const { adapter, calls } = setup();
    adapter.search('needle');
    adapter.search('needle');
    expect(calls.filter(c => c.startsWith('find:') || c.startsWith('stop:'))).toEqual(['find:needle:new', 'stop:clearSelection', 'find:needle:new']);
  });
});
