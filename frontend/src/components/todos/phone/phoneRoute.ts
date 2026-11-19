/**
 * Where To-dos is on a phone (P7, D-422): one screen at a time, each its own history entry so browser
 * back and Android back step out approval → to-do → list. The forms open over the screen they come
 * from, as overlays.
 */
export type PhoneTodosRoute =
  | { screen: 'list' }
  | { screen: 'todo'; number: number }
  /** Plan · Files: the to-do's attachments full screen; `tab` is the open one's key, the first when unset. */
  | { screen: 'files'; number: number; tab?: string }
  | { screen: 'approval'; number: number; id: string }
  | { screen: 'new' }
  | { screen: 'new-sub'; number: number };

const PREFIX = 'todos';

/** The history view a route records: the forms record the screen under them. */
export function routeView(route: PhoneTodosRoute): string {
  switch (route.screen) {
    case 'list':
    case 'new':
      return PREFIX;
    case 'todo':
    case 'new-sub':
      return `${PREFIX}:${route.number}`;
    case 'files':
      return `${PREFIX}:${route.number}:files`;
    case 'approval':
      return `${PREFIX}:${route.number}:approval:${route.id}`;
  }
}

/** The route a history view names, or null when it is not one of To-dos' (a Pane, a Session, nothing). */
export function parseRouteView(view: string | null): PhoneTodosRoute | null {
  if (view === PREFIX) return { screen: 'list' };
  const match = view === null ? null : /^todos:(\d+)(?::(files|approval:(.+)))?$/u.exec(view);
  if (!match) return null;
  const number = Number(match[1]);
  if (match[2] === undefined) return { screen: 'todo', number };
  if (match[2] === 'files') return { screen: 'files', number };
  return { screen: 'approval', number, id: match[3] };
}

/** A form, shown over the screen it opened from. */
export function isOverlayRoute(route: PhoneTodosRoute): boolean {
  return route.screen === 'new' || route.screen === 'new-sub';
}

/**
 * The screen back returns to: the to-do under its files, approval or New sub-to-do; a sub-to-do's
 * parent (`parentNumber`); the list under a to-do; and from the list, out of To-dos (null).
 */
export function routeParent(route: PhoneTodosRoute, parentNumber: number | null = null): PhoneTodosRoute | null {
  switch (route.screen) {
    case 'list':
      return null;
    case 'new':
      return { screen: 'list' };
    case 'todo':
      return parentNumber === null ? { screen: 'list' } : { screen: 'todo', number: parentNumber };
    case 'files':
    case 'approval':
    case 'new-sub':
      return { screen: 'todo', number: route.number };
  }
}

/**
 * The views under the current To-dos screen after a Back or Forward lands on `arrived` from `from`: Back pops
 * the one it returns to; Forward pushes the one it left, so the next in-app back steps through the history
 * instead of pushing a duplicate entry (round 7 QA, R28).
 */
export function stepTodosStack(stack: readonly string[], arrived: string, from: string | null): string[] {
  if (stack[stack.length - 1] === arrived) return stack.slice(0, -1);
  return from === null ? [...stack] : [...stack, from];
}
