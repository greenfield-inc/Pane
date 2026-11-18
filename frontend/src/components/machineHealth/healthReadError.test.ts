import { describe, expect, it } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import { healthReadProblem } from './healthReadError';

describe('healthReadProblem', () => {
  it('turns an older host\'s unknown-channel error into the update message', () => {
    const fromIpc = new Error('Error invoking remote method \'machines:read\': Error [ERR_UNKNOWN_CHANNEL]: No Pane daemon command registered for channel "resource-monitor:machine-health". This Pane does not have that command.');
    expect(healthReadProblem(fromIpc)).toEqual({ kind: 'outdated', message: 'Update Pane on this machine to see its health.' });
    expect(healthReadProblem(new PaneError('ERR_UNKNOWN_CHANNEL', 'No Pane daemon command registered for channel "x".'))).toMatchObject({ kind: 'outdated' });
  });

  it('reads an unreachable machine as offline, and keeps any other error\'s own words', () => {
    expect(healthReadProblem(new PaneError('ERR_MACHINE_OFFLINE', 'build-box is offline.'))).toEqual({ kind: 'offline', message: 'Offline' });
    expect(healthReadProblem(new Error('disk read failed'))).toEqual({ kind: 'error', message: 'disk read failed' });
  });
});
