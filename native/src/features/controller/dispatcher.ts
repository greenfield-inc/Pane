/**
 * Runs controller actions on the phone. Screens and sheets register a scope
 * with handlers by action id; the newest scope is asked first, and a handler
 * that returns false passes the action to the scope below it. The newest
 * scope also names the screen context the button bindings are read for.
 */
export type ActionHandler<Event> = (event: Event) => boolean | void;

export interface ActionScope<Context extends string, Action extends string, Event> {
  context: Context;
  handlers: Partial<Record<Action, ActionHandler<Event>>>;
}

export interface Dispatcher<Context extends string, Action extends string, Event> {
  /** Adds a scope on top; the returned function removes it. */
  register(scope: ActionScope<Context, Action, Event>): () => void;
  /** True when a handler took the action. */
  dispatch(action: Action, event: Event): boolean;
  /** The newest scope's context, or `fallback` with none registered. */
  context(fallback: Context): Context;
}

export function createDispatcher<Context extends string, Action extends string, Event>(): Dispatcher<Context, Action, Event> {
  const scopes: ActionScope<Context, Action, Event>[] = [];
  return {
    register(scope) {
      scopes.push(scope);
      return () => {
        const index = scopes.lastIndexOf(scope);
        if (index >= 0) scopes.splice(index, 1);
      };
    },
    dispatch(action, event) {
      for (let index = scopes.length - 1; index >= 0; index -= 1) {
        const handler = scopes[index].handlers[action];
        if (handler && handler(event) !== false) return true;
      }
      return false;
    },
    context(fallback) {
      return scopes.at(-1)?.context ?? fallback;
    },
  };
}
