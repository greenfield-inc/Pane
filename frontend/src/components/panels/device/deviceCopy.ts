import type { DevicePanelState, DeviceRecordingEnd, DeviceStopCause } from '../../../../../shared/types/devices';

/** " · iOS 27.0 · This Mac": what follows the device's name under the phone. */
export function deviceCaption(state: Pick<DevicePanelState, 'os' | 'machine'>): string {
  return [state.os, state.machine].filter(Boolean).map(part => ` · ${part}`).join('');
}

export interface DevicePhaseCopy {
  title: string;
  detail?: string;
  action?: 'boot' | 'take-over';
}

/** The title of an off device, by who or what shut it down. */
const OFF_TITLES = {
  person: 'You shut it down',
  agent: 'The agent shut it down',
  idle: 'Shut down after 10 minutes idle',
  freed: 'Shut down to free memory',
  archived: 'Shut down when its Pane was archived',
  quit: 'Shut down when Pane quit',
  outside: 'Shut down outside Pane',
} satisfies Record<DeviceStopCause, string>;

/** The title of a closed device (booted, held by no Pane), by who or what let it go. */
const CLOSED_TITLES = {
  person: 'You closed it',
  agent: 'The agent closed it',
  idle: 'Let go after 10 minutes idle',
  freed: 'Closed to free memory',
  archived: 'Closed when its Pane was archived',
  quit: 'Closed when Pane quit',
  outside: 'Closed outside Pane',
} satisfies Record<DeviceStopCause, string>;

/** The words that cover the screen in each state the device tab can be in, naming who or what stopped it; booting has none (a skeleton). */
export function devicePhaseCopy(state: Pick<DevicePanelState, 'phase' | 'name' | 'heldBy' | 'stoppedBy'>): DevicePhaseCopy | undefined {
  switch (state.phase) {
    case 'installing':
      return { title: 'Installing device tools', detail: 'First use on this computer. This takes about a minute.' };
    case 'off':
      return state.stoppedBy === 'outside'
        ? { title: `${state.name} shut down`, detail: 'It stopped outside Pane: from Simulator, or it crashed.', action: 'boot' }
        : { title: state.stoppedBy ? OFF_TITLES[state.stoppedBy] : 'Shut down', action: 'boot' };
    case 'closed':
      return { title: state.stoppedBy ? CLOSED_TITLES[state.stoppedBy] : 'Closed', detail: 'No Pane is using it. Boot opens it here again.', action: 'boot' };
    case 'in-use':
      return { title: `In use by ${state.heldBy?.paneName ?? 'another Pane'}`, detail: 'One simulator per machine. Taking over moves it to this Pane.', action: 'take-over' };
    case 'error':
      return { title: `${state.name} did not start`, detail: 'The message under the phone, or the agent\'s tool call, says why.', action: 'boot' };
    default:
      return undefined;
  }
}

/** What the tab says when its recording ends: who or what ended it, and where the video is or why it did not save. */
export function recordingEndCopy(ended: DeviceRecordingEnd): string {
  const cause = ended.by === 'person' ? 'You stopped the recording.'
    : ended.by === 'limit' ? 'The recording stopped at its 10-minute limit.'
      : ended.by === 'agent' ? 'The agent stopped the recording.'
        : ended.by === 'quit' ? 'The recording stopped when Pane quit.'
          : 'The recording stopped when the device did.';
  if (ended.recording) return `${cause} Saved${ended.recording.machine ? ` on ${ended.recording.machine}` : ''}: ${ended.recording.path}`;
  return ended.problem ? `${cause} ${ended.problem}` : cause;
}
