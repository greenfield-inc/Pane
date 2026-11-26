import * as pads from '../../../modules/pane-controller';

import { useControllerState } from './controllerState';
import { activePad } from './runtime';

/** A short pulse on the pad in hand when the host confirms a send; nothing without a controller. */
export function rumbleOnConfirm(): void {
  if (!useControllerState.getState().active || !activePad.id || !activePad.hasRumble) return;
  pads.rumble(activePad.id, 120, 0.6);
}
