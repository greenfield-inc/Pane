import type { ControllerActionId, ControllerContext } from '@shared/controller/bindings';

import { createDispatcher } from './dispatcher';
import { createFocusRegistry } from './focusRegistry';

/** What a handler is told: holds report their start and end. */
export interface ControllerActionEvent {
  phase?: 'start' | 'end';
}

/** Screens register handlers here (useControllerActions); the input loop dispatches to them. */
export const controllerActions = createDispatcher<ControllerContext, ControllerActionId, ControllerActionEvent>();

/** Controls opt in here (useFocusable); the ring draws at the focused one. */
export const controllerFocus = createFocusRegistry();

/** The pad that pressed last, which rumbles on a confirmed send. */
export const activePad = { id: null as string | null, hasRumble: false };
