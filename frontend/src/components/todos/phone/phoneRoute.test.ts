import { describe, expect, it } from 'vitest';
import { isOverlayRoute, parseRouteView, routeParent, routeView, type PhoneTodosRoute } from './phoneRoute';

const list: PhoneTodosRoute = { screen: 'list' };
const todo: PhoneTodosRoute = { screen: 'todo', number: 12 };
const files: PhoneTodosRoute = { screen: 'files', number: 12, tab: 'attachment:3' };
const approval: PhoneTodosRoute = { screen: 'approval', number: 12, id: 'host:q11' };

describe('each phone screen is a history entry (R28)', () => {
  it('names the list, a to-do, its files and an approval', () => {
    expect(routeView(list)).toBe('todos');
    expect(routeView(todo)).toBe('todos:12');
    expect(routeView(files)).toBe('todos:12:files');
    expect(routeView(approval)).toBe('todos:12:approval:host:q11');
  });

  it('reads them back, with an approval id that has colons of its own', () => {
    expect(parseRouteView('todos')).toEqual(list);
    expect(parseRouteView('todos:12')).toEqual(todo);
    expect(parseRouteView('todos:12:files')).toEqual({ screen: 'files', number: 12 });
    expect(parseRouteView('todos:12:approval:host:q11')).toEqual(approval);
  });

  it('is not a to-dos view for a Pane, a Session, nothing or a broken one', () => {
    expect(parseRouteView('pane:abc')).toBeNull();
    expect(parseRouteView('session:abc')).toBeNull();
    expect(parseRouteView(null)).toBeNull();
    expect(parseRouteView('todos:x')).toBeNull();
    expect(parseRouteView('todos:12:approval:')).toBeNull();
  });

  it('keeps the forms as overlays on the screen they open from', () => {
    expect(isOverlayRoute({ screen: 'new' })).toBe(true);
    expect(isOverlayRoute({ screen: 'new-sub', number: 12 })).toBe(true);
    expect(isOverlayRoute(todo)).toBe(false);
    expect(routeView({ screen: 'new' })).toBe('todos');
    expect(routeView({ screen: 'new-sub', number: 12 })).toBe('todos:12');
  });
});

describe('back steps out one screen: approval or files → to-do → list', () => {
  it('goes to the screen underneath', () => {
    expect(routeParent(approval)).toEqual(todo);
    expect(routeParent(files)).toEqual(todo);
    expect(routeParent({ screen: 'new-sub', number: 12 })).toEqual(todo);
    expect(routeParent(todo)).toEqual(list);
    expect(routeParent({ screen: 'new' })).toEqual(list);
  });

  it('leaves To-dos from the list', () => {
    expect(routeParent(list)).toBeNull();
  });

  it('goes from a sub-to-do to its parent', () => {
    expect(routeParent({ screen: 'todo', number: 14 }, 12)).toEqual(todo);
  });
});
