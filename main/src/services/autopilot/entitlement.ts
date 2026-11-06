import { PaneError } from '../../../../shared/paneError';
import type { AutopilotEntitlement } from '../../../../shared/types/autopilot';

/**
 * Autopilot is a paid Pane feature (D-65). Every way it turns on or starts goes through this one
 * check. Step 1 has no billing: everyone is entitled, with no account or network call. Pricing
 * later replaces only what this reads.
 *
 * Test hook: PANE_AUTOPILOT_ENTITLEMENT=denied (or setAutopilotEntitlementForTests) forces
 * "not entitled", so the disabled switch and AUTOPILOT_NOT_ENTITLED can be checked.
 */
let forced: AutopilotEntitlement | undefined;

const NOT_ENTITLED: AutopilotEntitlement = {
  entitled: false,
  reason: 'Autopilot is not included in this Pane account.',
  next: 'Autopilot is a paid Pane feature. Check your plan at runpane.com, then turn Autopilot on again in Settings › Advanced › Experimental.',
};

export function autopilotEntitlement(): AutopilotEntitlement {
  if (forced) return forced;
  if (process.env.PANE_AUTOPILOT_ENTITLEMENT === 'denied') return NOT_ENTITLED;
  return { entitled: true };
}

/** Throws AUTOPILOT_NOT_ENTITLED, saying what was not done and what to do next. */
export function assertAutopilotEntitled(action: string): void {
  const entitlement = autopilotEntitlement();
  if (entitlement.entitled) return;
  throw new PaneError('AUTOPILOT_NOT_ENTITLED', `${entitlement.reason ?? 'Autopilot is not available.'} ${action} was not done.`, entitlement.next);
}

/** Tests only: force the check's answer, or pass undefined to go back to the real one. */
export function setAutopilotEntitlementForTests(entitled: boolean | undefined): void {
  forced = entitled === undefined ? undefined : entitled ? { entitled: true } : NOT_ENTITLED;
}
