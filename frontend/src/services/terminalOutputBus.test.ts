import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TerminalOutputEvent, TerminalPanelOutputEvent, TerminalSessionOutputEvent,
} from '../../../shared/types/panels';

type OutputCallback = (event: TerminalOutputEvent) => void;

/**
 * The renderer's IPC bridge, reduced to the one event the bus subscribes to.
 * Counting subscriptions is the point: one for the whole grid, not one per
 * live tile.
 */
function installElectronApi() {
  const callbacks = new Set<OutputCallback>();
  const onTerminalOutput = vi.fn((callback: OutputCallback) => {
    callbacks.add(callback);
    return () => callbacks.delete(callback);
  });

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { electronAPI: { events: { onTerminalOutput } } },
  });

  return {
    onTerminalOutput,
    get subscriptionCount() { return callbacks.size; },
    emit(event: TerminalOutputEvent) {
      for (const callback of [...callbacks]) callback(event);
    },
  };
}

function outputEvent(panelId: string, output: string): TerminalPanelOutputEvent {
  return { panelId, sessionId: 'session-1', output };
}

describe('terminalOutputBus', () => {
  let api: ReturnType<typeof installElectronApi>;
  let subscribeToTerminalOutput: typeof import('./terminalOutputBus').subscribeToTerminalOutput;

  beforeEach(async () => {
    api = installElectronApi();
    // Fresh module per test: the bus holds the subscription in module state.
    vi.resetModules();
    ({ subscribeToTerminalOutput } = await import('./terminalOutputBus'));
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('takes one IPC subscription however many tiles are listening', () => {
    const unsubscribes = ['a', 'b', 'c'].map(panelId => subscribeToTerminalOutput(panelId, () => {}));

    // Twelve live tiles used to mean twelve listeners, each visited by every
    // panel's output before deciding the chunk was not theirs.
    expect(api.onTerminalOutput).toHaveBeenCalledTimes(1);
    expect(api.subscriptionCount).toBe(1);

    for (const unsubscribe of unsubscribes) unsubscribe();
  });

  it('delivers a panel chunk only to the tile watching that panel', () => {
    const forA: string[] = [];
    const forB: string[] = [];
    const stopA = subscribeToTerminalOutput('a', output => forA.push(output));
    const stopB = subscribeToTerminalOutput('b', output => forB.push(output));

    api.emit(outputEvent('a', 'from a'));
    api.emit(outputEvent('b', 'from b'));
    api.emit(outputEvent('c', 'nobody is watching this'));

    expect(forA).toEqual(['from a']);
    expect(forB).toEqual(['from b']);
    stopA();
    stopB();
  });

  it('releases the IPC subscription with the last listener', () => {
    const stopA = subscribeToTerminalOutput('a', () => {});
    const stopB = subscribeToTerminalOutput('b', () => {});

    stopA();
    expect(api.subscriptionCount).toBe(1);
    stopB();
    expect(api.subscriptionCount).toBe(0);
  });

  it('re-subscribes after the grid is left and entered again', () => {
    subscribeToTerminalOutput('a', () => {})();
    const received: string[] = [];
    const stop = subscribeToTerminalOutput('a', output => received.push(output));

    api.emit(outputEvent('a', 'still delivered'));

    expect(api.onTerminalOutput).toHaveBeenCalledTimes(2);
    expect(received).toEqual(['still delivered']);
    stop();
  });

  it('survives a listener that unsubscribes itself mid-dispatch', () => {
    const received: string[] = [];
    let stopFirst = () => {};
    stopFirst = subscribeToTerminalOutput('a', () => { stopFirst(); });
    const stopSecond = subscribeToTerminalOutput('a', output => received.push(output));

    api.emit(outputEvent('a', 'delivered to both'));

    expect(received).toEqual(['delivered to both']);
    stopSecond();
  });

  it('ignores an event that carries no panel id', () => {
    const received: string[] = [];
    const stop = subscribeToTerminalOutput('a', output => received.push(output));

    // The same channel also carries whole-session output, which names no panel.
    const sessionOutput: TerminalSessionOutputEvent = {
      sessionId: 'session-1', type: 'stdout', data: 'session output',
    };
    api.emit(sessionOutput);

    expect(received).toEqual([]);
    stop();
  });
});
