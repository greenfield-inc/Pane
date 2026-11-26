import { useEffect, useEffectEvent } from 'react';

import type { ControllerActionId, ControllerContext } from '@shared/controller/bindings';

import { controllerActions, type ControllerActionEvent } from './runtime';

type Handlers = Partial<Record<ControllerActionId, (event: ControllerActionEvent) => boolean | void>>;

/**
 * Registers this screen's controller handlers while it is mounted and
 * `enabled`. The newest screen or sheet is asked first; return false to pass
 * an action to the one below. Handlers always see the latest render.
 */
export function useControllerActions(context: ControllerContext, handlers: Handlers, enabled = true): void {
  const run = useEffectEvent((action: ControllerActionId, event: ControllerActionEvent) => {
    const handler = handlers[action];
    return handler ? handler(event) : false;
  });
  const ids = Object.keys(handlers).sort().join(',');
  useEffect(() => {
    if (!enabled) return;
    const proxied: Handlers = {};
    for (const id of ids.split(',') as ControllerActionId[]) proxied[id] = event => run(id, event);
    return controllerActions.register({ context, handlers: proxied });
  }, [context, ids, enabled]);
}
