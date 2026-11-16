import type { DevicePanelState } from '../../../../../shared/types/devices';

/** " · iOS 27.0 · This Mac": what follows the device's name under the phone. */
export function deviceCaption(state: Pick<DevicePanelState, 'os' | 'machine'>): string {
  return [state.os, state.machine].filter(Boolean).map(part => ` · ${part}`).join('');
}

export interface DevicePhaseCopy {
  title: string;
  detail?: string;
  action?: 'boot' | 'take-over';
}

/** The words that cover the screen in each state the device tab can be in. */
export function devicePhaseCopy(state: Pick<DevicePanelState, 'phase' | 'name' | 'heldBy'>): DevicePhaseCopy | undefined {
  switch (state.phase) {
    case 'installing':
      return { title: 'Installing device tools', detail: 'First use on this computer. This takes about a minute.' };
    case 'booting':
      return { title: `Booting ${state.name}` };
    case 'off':
      return { title: 'Shut down after 10 minutes idle', action: 'boot' };
    case 'closed':
      return { title: 'Closed by the agent', detail: 'It shuts down in 10 minutes unless a Pane opens it.', action: 'boot' };
    case 'in-use':
      return { title: `In use by ${state.heldBy?.paneName ?? 'another Pane'}`, detail: 'One simulator per machine. Taking over moves it to this Pane.', action: 'take-over' };
    case 'error':
      return { title: `${state.name} did not start`, detail: 'The agent\'s tool call says why.', action: 'boot' };
    default:
      return undefined;
  }
}
