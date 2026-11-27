import { beforeEach, describe, expect, it } from 'vitest';

import { closedAny, forgetScreen, rememberScreen, screenCount, takeScreenToReopen } from './reopenScreen';

// The root state the navigation container reports: Expo Router's root route holds the stack.
const root = (...routes: { name: string; key?: string; params?: Record<string, string> }[]) => ({
  index: 0,
  routes: [{ name: '__root', state: { index: routes.length - 1, routes } }],
});
const home = { name: 'index' };
const pane = { name: 'pane/[paneId]/index', params: { paneId: 'p1', panelId: 'tab-2' } };
const paneExists = () => true;

describe('reopening the screen a restart closed', () => {
  beforeEach(forgetScreen);

  it('reopens the Pane and tab that was open, once, on the same computer', () => {
    rememberScreen('host-a', root(home, pane));

    expect(takeScreenToReopen('host-a', paneExists)).toEqual({ pathname: '/pane/[paneId]', params: { paneId: 'p1', panelId: 'tab-2' } });
    expect(takeScreenToReopen('host-a', paneExists)).toBeNull();
  });

  it('reopens a Session, an approval and Settings pages by their own paths', () => {
    rememberScreen('host-a', root(home, { name: 'session/[sessionId]', params: { sessionId: 's1' } }));
    expect(takeScreenToReopen('host-a', paneExists)).toEqual({ pathname: '/session/[sessionId]', params: { sessionId: 's1' } });

    rememberScreen('host-a', root(home, { name: 'approval/[notifyId]', params: { notifyId: 'n1', paneId: 'p1' } }));
    expect(takeScreenToReopen('host-a', paneExists)).toEqual({ pathname: '/approval/[notifyId]', params: { notifyId: 'n1', paneId: 'p1' } });

    rememberScreen('host-a', root(home, { name: 'settings' }, { name: 'settings/voice' }));
    expect(takeScreenToReopen('host-a', paneExists)).toEqual({ pathname: '/settings/voice', params: {} });
  });

  it('reopens the screen under a sheet, not the sheet', () => {
    rememberScreen('host-a', root(home, pane, { name: 'pane/[paneId]/permission', params: { paneId: 'p1' } }));

    expect(takeScreenToReopen('host-a', paneExists)).toEqual({ pathname: '/pane/[paneId]', params: { paneId: 'p1', panelId: 'tab-2' } });
  });

  it('opens nothing over Home, or with only a sheet over Home', () => {
    rememberScreen('host-a', root(home));
    expect(takeScreenToReopen('host-a', paneExists)).toBeNull();

    rememberScreen('host-a', root(home, { name: 'new' }));
    expect(takeScreenToReopen('host-a', paneExists)).toBeNull();
  });

  it('opens nothing on another computer', () => {
    rememberScreen('host-a', root(home, pane));

    expect(takeScreenToReopen('host-b', paneExists)).toBeNull();
  });

  it('opens nothing for a Pane that is gone', () => {
    rememberScreen('host-a', root(home, pane));

    expect(takeScreenToReopen('host-a', paneId => paneId !== 'p1')).toBeNull();
  });

  it('opens nothing after the person left the app', () => {
    rememberScreen('host-a', root(pane));
    forgetScreen();

    expect(takeScreenToReopen('host-a', paneExists)).toBeNull();
  });
});

describe('counting the screens in the stack', () => {
  it('counts the root and every screen, but no sheet', () => {
    expect(screenCount(root(home))).toBe(1);
    expect(screenCount(root(home, pane))).toBe(2);
    expect(screenCount(root(home, pane, { name: 'pane/[paneId]/permission', params: { paneId: 'p1' } }))).toBe(2);
    expect(screenCount(root(home, pane, { name: 'settings' }))).toBe(3);
  });
});

describe('telling whether a screen closed', () => {
  const keyed = (key: string) => ({ name: 'pane/[paneId]/index', key });

  it('is true when Back closes the top screen or a sheet over it', () => {
    expect(closedAny(root({ ...home, key: 'h' }, keyed('a')), root({ ...home, key: 'h' }))).toBe(true);
    expect(closedAny(root({ ...home, key: 'h' }, keyed('a'), { name: 'pane/[paneId]/notify', key: 's' }), root({ ...home, key: 'h' }, keyed('a')))).toBe(true);
  });

  it('is true when Home replaces the open screen with another', () => {
    expect(closedAny(root({ ...home, key: 'h' }, keyed('a')), root({ ...home, key: 'h' }, keyed('b')))).toBe(true);
  });

  it('is false when a screen opens over the others', () => {
    expect(closedAny(root({ ...home, key: 'h' }, keyed('a')), root({ ...home, key: 'h' }, keyed('a'), keyed('b')))).toBe(false);
  });
});
