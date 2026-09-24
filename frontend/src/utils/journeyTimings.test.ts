import { beforeEach, describe, expect, it, vi } from 'vitest';

let now = 0;
const invoke = vi.fn(() => Promise.resolve());

async function loadJourneys() {
  vi.resetModules();
  return import('./journeyTimings');
}

beforeEach(() => {
  now = 0;
  invoke.mockClear();
  vi.stubGlobal('window', { electronAPI: { invoke } });
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => callback(now));
});

describe('journey timings', () => {
  it('times a created pane to its view, not as a switch when it gets selected', async () => {
    const journeys = await loadJourneys();
    journeys.startCreatePane();
    now = 300;
    journeys.claimCreatedPane('new-pane');
    journeys.claimCreatedPane('second-pane-of-a-batch');
    journeys.startSwitchPane('new-pane');
    now = 1800;
    journeys.markPaneTerminalShown('new-pane');
    journeys.markPaneViewShown('second-pane-of-a-batch');
    journeys.markPaneViewShown('new-pane');

    expect(invoke.mock.calls).toEqual([['journeys:record', { journey: 'create_pane', durationMs: 1800 }]]);
  });

  it('times a switch only when the target pane shows its terminal, once', async () => {
    const journeys = await loadJourneys();
    journeys.startSwitchPane('b');
    now = 90;
    journeys.markPaneTerminalShown('a');
    now = 250;
    journeys.markPaneTerminalShown('b');
    now = 400;
    journeys.markPaneTerminalShown('b');

    expect(invoke.mock.calls).toEqual([['journeys:record', { journey: 'switch_pane', durationMs: 250 }]]);
  });

  it('times a prompt to the first output of the same panel and drops abandoned journeys', async () => {
    const journeys = await loadJourneys();
    journeys.startSendPrompt('panel-1');
    now = 40;
    journeys.markPanelOutput('panel-2');
    now = 65;
    journeys.markPanelOutput('panel-1');
    journeys.markPanelOutput('panel-1');
    journeys.startSwitchPane('c');
    now = 65 + 61_000;
    journeys.markPaneTerminalShown('c');

    expect(invoke.mock.calls).toEqual([['journeys:record', { journey: 'send_prompt', durationMs: 65 }]]);
  });
});
