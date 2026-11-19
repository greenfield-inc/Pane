import { describe, expect, it } from 'vitest';
import type { DevicePanelState, DeviceStopCause } from '../../../../../shared/types/devices';
import { devicePhaseCopy, recordingEndCopy } from './deviceCopy';

const off = (stoppedBy?: DeviceStopCause) => devicePhaseCopy({ phase: 'off', name: 'iPhone 12', stoppedBy } satisfies Pick<DevicePanelState, 'phase' | 'name' | 'stoppedBy'>);

describe('what an off device says', () => {
  it('names the person when they shut it down', () => {
    expect(off('person')?.title).toBe('You shut it down');
  });

  it('says "after 10 minutes idle" only when the idle timer shut it down', () => {
    const causes: DeviceStopCause[] = ['person', 'agent', 'idle', 'freed', 'archived', 'quit', 'outside'];
    const idle = causes.filter(cause => off(cause)?.title.includes('10 minutes idle'));
    expect(idle).toEqual(['idle']);
    expect(off()?.title).toBe('Shut down');
  });

  it('says a device stopped outside Pane by its name, and that Pane quitting shut one down', () => {
    expect(off('outside')).toMatchObject({ title: 'iPhone 12 shut down', detail: expect.stringContaining('outside Pane') });
    expect(off('quit')?.title).toBe('Shut down when Pane quit');
  });

  it('names the agent when its device_close let the device go', () => {
    expect(devicePhaseCopy({ phase: 'closed', name: 'iPhone 12', stoppedBy: 'agent' })?.title).toBe('The agent closed it');
  });
});

describe('what a finished recording says', () => {
  const recording = { path: '/Users/me/.pane/devices/recordings/pane-1795029515252.mp4' };

  it('says the person stopped it, with the whole path', () => {
    expect(recordingEndCopy({ by: 'person', recording, at: 1 })).toBe(`You stopped the recording. Saved: ${recording.path}`);
  });

  it('mentions the 10-minute limit only when the limit stopped it', () => {
    expect(recordingEndCopy({ by: 'limit', recording, at: 1 })).toContain('10-minute limit');
    for (const by of ['person', 'agent', 'device', 'quit'] as const) expect(recordingEndCopy({ by, recording, at: 1 })).not.toContain('limit');
  });

  it('names the Mac a recording was saved on, and says why one did not save', () => {
    expect(recordingEndCopy({ by: 'agent', recording: { ...recording, machine: 'Studio Mac' }, at: 1 })).toBe(`The agent stopped the recording. Saved on Studio Mac: ${recording.path}`);
    expect(recordingEndCopy({ by: 'device', problem: 'It did not save.', at: 1 })).toBe('The recording stopped when the device did. It did not save.');
    expect(recordingEndCopy({ by: 'quit', problem: 'It did not save.', at: 1 })).toBe('The recording stopped when Pane quit. It did not save.');
  });
});
