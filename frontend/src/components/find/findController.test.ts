import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeFind,
  getFindBar,
  openFind,
  registerFindTarget,
  reportFindResult,
  resetFindForTests,
  setFindQuery,
  stepFind,
  syncFindMode,
  type FindAdapter,
  type FindMode,
} from './findController';

interface FakeAdapter extends FindAdapter {
  calls: string[];
  selection: string;
  currentMode: FindMode;
}

function fakeAdapter(total = 3): FakeAdapter {
  let current = 0;
  const adapter: FakeAdapter = {
    calls: [],
    selection: '',
    currentMode: 'text',
    mode: () => adapter.currentMode,
    search(query) {
      adapter.calls.push(`search:${query}`);
      current = total > 0 ? 1 : 0;
      return { current, total };
    },
    step(direction) {
      adapter.calls.push(`step:${direction}`);
      current = direction === 'next' ? (current % total) + 1 : current <= 1 ? total : current - 1;
      return { current, total };
    },
    clear() { adapter.calls.push('clear'); },
    selectedText: () => adapter.selection,
    restoreFocus() { adapter.calls.push('restoreFocus'); },
  };
  return adapter;
}

function register(panelId: string, adapter: FindAdapter) {
  return registerFindTarget(panelId, { adapter, root: () => null });
}

describe('find controller', () => {
  beforeEach(() => resetFindForTests());

  it('opens an empty bar and searches as the query changes', () => {
    const adapter = fakeAdapter(12);
    register('term', adapter);

    expect(openFind('term')).toBe(true);
    expect(getFindBar('term')).toMatchObject({ open: true, query: '', noText: false, result: { current: 0, total: 0 } });

    setFindQuery('term', 'needle');
    expect(adapter.calls).toEqual(['search:needle']);
    expect(getFindBar('term').result).toEqual({ current: 1, total: 12 });
  });

  it('starts the query from selected text', () => {
    const adapter = fakeAdapter();
    adapter.selection = '  install ';
    register('preview', adapter);

    openFind('preview');

    expect(getFindBar('preview').query).toBe('install');
    expect(adapter.calls).toEqual(['search:install']);
  });

  it('ignores a multi-line selection', () => {
    const adapter = fakeAdapter();
    adapter.selection = 'one\ntwo';
    register('preview', adapter);

    openFind('preview');

    expect(getFindBar('preview').query).toBe('');
  });

  it('moves with next and previous, wrapping', () => {
    const adapter = fakeAdapter(3);
    register('term', adapter);
    openFind('term');
    setFindQuery('term', 'x');

    stepFind('term', 'prev');
    expect(getFindBar('term').result).toEqual({ current: 3, total: 3 });
    stepFind('term', 'next');
    expect(getFindBar('term').result).toEqual({ current: 1, total: 3 });
  });

  it('closes by clearing highlights, keeping the query, and returning focus', () => {
    const adapter = fakeAdapter();
    register('term', adapter);
    openFind('term');
    setFindQuery('term', 'x');

    closeFind('term');

    expect(adapter.calls.slice(-2)).toEqual(['clear', 'restoreFocus']);
    expect(getFindBar('term')).toMatchObject({ open: false, query: 'x', result: { current: 0, total: 0 } });
  });

  it('reopens on the last query when stepping with the bar closed', () => {
    const adapter = fakeAdapter();
    register('term', adapter);
    openFind('term');
    setFindQuery('term', 'needle');
    closeFind('term');
    adapter.calls.length = 0;

    expect(stepFind('term', 'next')).toBe(true);

    expect(getFindBar('term').open).toBe(true);
    expect(adapter.calls).toEqual(['search:needle', 'step:next']);
    expect(getFindBar('term').result).toEqual({ current: 2, total: 3 });
  });

  it('reopens and moves back with Previous when the bar is closed', () => {
    const adapter = fakeAdapter(3);
    register('preview', adapter);
    openFind('preview');
    setFindQuery('preview', 'needle');
    closeFind('preview');

    stepFind('preview', 'prev');

    expect(getFindBar('preview').result).toEqual({ current: 3, total: 3 });
  });

  it('keeps the remembered query, not the selection, when Cmd+G reopens', () => {
    const adapter = fakeAdapter();
    register('preview', adapter);
    openFind('preview');
    setFindQuery('preview', 'needle');
    closeFind('preview');
    adapter.selection = 'other';
    adapter.calls.length = 0;

    stepFind('preview', 'next');

    expect(getFindBar('preview').query).toBe('needle');
    expect(adapter.calls).toEqual(['search:needle', 'step:next']);
  });

  it('closes the bar when the tab switches to an editor with its own find', () => {
    const adapter = fakeAdapter();
    register('file', adapter);
    openFind('file');
    setFindQuery('file', 'needle');
    adapter.calls.length = 0;

    adapter.currentMode = 'native';
    syncFindMode('file');

    expect(adapter.calls).toEqual(['clear']);
    expect(getFindBar('file')).toMatchObject({ open: false, query: 'needle' });
  });

  it('switches an open bar to the no-text notice and back as the content changes', () => {
    const adapter = fakeAdapter(4);
    register('file', adapter);
    openFind('file');
    setFindQuery('file', 'needle');

    adapter.currentMode = 'none';
    syncFindMode('file');
    expect(getFindBar('file')).toMatchObject({ open: true, noText: true, result: { current: 0, total: 0 } });

    adapter.calls.length = 0;
    adapter.currentMode = 'text';
    syncFindMode('file');
    expect(adapter.calls).toEqual(['search:needle']);
    expect(getFindBar('file')).toMatchObject({ open: true, noText: false, result: { current: 1, total: 4 } });
  });

  it('fits an open bar to a remounted tab whose content changed', () => {
    const image = fakeAdapter();
    image.currentMode = 'none';
    const unregister = register('file', image);
    openFind('file');
    expect(getFindBar('file').noText).toBe(true);
    unregister();

    const markdown = fakeAdapter(2);
    register('file', markdown);
    expect(getFindBar('file').noText).toBe(false);
  });

  it('does nothing on step with the bar closed and no query', () => {
    register('term', fakeAdapter());
    expect(stepFind('term', 'next')).toBe(false);
    expect(getFindBar('term').open).toBe(false);
  });

  it('opens with a no-text notice in a tab with nothing to search', () => {
    const adapter = fakeAdapter();
    adapter.currentMode = 'none';
    register('image', adapter);

    openFind('image');
    setFindQuery('image', 'x');

    expect(getFindBar('image')).toMatchObject({ open: true, noText: true });
    expect(adapter.calls).toEqual([]);
  });

  it('declines when the tab uses its own find (Monaco)', () => {
    const adapter = fakeAdapter();
    adapter.currentMode = 'native';
    register('code', adapter);

    expect(openFind('code')).toBe(false);
    expect(getFindBar('code').open).toBe(false);
  });

  it('keeps each tab on its own query', () => {
    register('term', fakeAdapter());
    register('preview', fakeAdapter());
    openFind('term');
    setFindQuery('term', 'alpha');
    openFind('preview');
    setFindQuery('preview', 'beta');

    expect(getFindBar('term').query).toBe('alpha');
    expect(getFindBar('preview').query).toBe('beta');
  });

  it('accepts results that arrive later (browser, live terminal output)', () => {
    register('browser', { ...fakeAdapter(), search: () => undefined });
    openFind('browser');
    setFindQuery('browser', 'needle');

    reportFindResult('browser', { current: 2, total: 7 });

    expect(getFindBar('browser').result).toEqual({ current: 2, total: 7 });
  });

  it('re-runs an open search when the tab remounts', () => {
    const first = fakeAdapter();
    const unregister = register('browser', first);
    openFind('browser');
    setFindQuery('browser', 'needle');
    unregister();

    const second = fakeAdapter();
    register('browser', second);

    expect(second.calls).toEqual(['search:needle']);
  });
});
