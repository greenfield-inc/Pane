import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendTerminalInput } from './terminalInput';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendTerminalInput', () => {
  it('forwards input on the terminal input channel', () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { electronAPI: { invoke } });
    sendTerminalInput('panel-1', '\x1b[A');
    expect(invoke).toHaveBeenCalledWith('terminal:input', 'panel-1', '\x1b[A');
  });

  it('handles discarded input so it never becomes an unhandled rejection', async () => {
    const error = new Error('Remote Pane disconnected; pending terminal input was discarded');
    vi.stubGlobal('window', { electronAPI: { invoke: vi.fn().mockRejectedValue(error) } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      sendTerminalInput('panel-1', 'a');
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[Terminal] Input was not delivered:', error);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
