import { describe, expect, it } from 'vitest';
import { restartToUpdateToastCopy, restoredToastMessage } from './restartToUpdateCopy';
import type { UpdateRestoreResult } from '../../../shared/types/updater';

// Expected strings are the cover sheet's "Exact copy".
const COMES_BACK = 'Restart now and everything comes back: Panes, tabs, splits and agents.';
const BUSY_TAIL = 'Restarting ends what is running and any pending approval. Conversations come back after the restart.';

describe('restartToUpdateToastCopy', () => {
  it('offers the idle restart with the Pane count and the runpane note', () => {
    expect(restartToUpdateToastCopy({ kind: 'idle', version: '2.4.203', paneCount: 14 })).toEqual({
      title: 'Pane 2.4.203 is ready',
      body: `All 14 Panes have been idle for 5 minutes. ${COMES_BACK}`,
      note: 'Brings Pane up to date with the runpane your agents use.',
    });
  });

  it('speaks to a single Pane', () => {
    expect(restartToUpdateToastCopy({ kind: 'idle', version: '2.4.203', paneCount: 1 }).body)
      .toBe(`Your Pane has been idle for 5 minutes. ${COMES_BACK}`);
    expect(restartToUpdateToastCopy({ kind: 'clicked-idle', version: '2.4.203', paneCount: 1 }).body)
      .toBe(`Your Pane is idle. ${COMES_BACK}`);
  });

  it('drops the 5 minute hold when the pill was clicked', () => {
    expect(restartToUpdateToastCopy({ kind: 'clicked-idle', version: '2.4.203', paneCount: 3 })).toEqual({
      title: 'Pane 2.4.203 is ready',
      body: `All 3 Panes are idle. ${COMES_BACK}`,
      note: 'Brings Pane up to date with the runpane your agents use.',
    });
  });

  it('names the first busy reason', () => {
    const busy = (reason: 'agents' | 'run-script' | 'archive', agentCount = 0) =>
      restartToUpdateToastCopy({ kind: 'busy', version: '2.4.203', busy: { reason, agentCount } });

    expect(busy('agents', 2)).toEqual({
      title: 'Pane 2.4.203 is ready',
      body: `2 agents are still working or waiting for you. ${BUSY_TAIL}`,
    });
    expect(busy('agents', 1).body).toBe(`1 agent is still working or waiting for you. ${BUSY_TAIL}`);
    expect(busy('run-script').body).toBe(`A run script is still running. ${BUSY_TAIL}`);
    expect(busy('archive').body).toBe(`Worktree removal is still running. ${BUSY_TAIL}`);
  });

  it('describes the scheduled restart', () => {
    expect(restartToUpdateToastCopy({ kind: 'tonight', version: '2.4.203' })).toEqual({
      title: 'Pane 2.4.203 restarts tonight',
      body: 'Between 2:00 and 5:00, once everything has been idle for an hour and nobody has used the computer for 30 minutes. Everything comes back: Panes, tabs, splits and agents.',
    });
  });
});

describe('restoredToastMessage', () => {
  const result = (overrides: Partial<UpdateRestoreResult>): UpdateRestoreResult => ({
    source: 'toast',
    fromVersion: '2.4.202',
    toVersion: '2.4.203',
    installed: true,
    panesRestored: 4,
    ...overrides,
  });

  it('reports the new version and the Panes that came back', () => {
    expect(restoredToastMessage(result({}))).toBe('Pane updated to 2.4.203. 4 Panes are back.');
    expect(restoredToastMessage(result({ panesRestored: 1 }))).toBe('Pane updated to 2.4.203. Your Pane is back.');
  });

  it('says how to retry when the update did not install', () => {
    expect(restoredToastMessage(result({ installed: false, toVersion: '2.4.202' })))
      .toBe('Pane restarted, but the update did not install. Your Panes are back. To try again, open Settings and choose Check Now.');
  });
});
