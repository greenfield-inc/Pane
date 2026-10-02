import { afterEach, describe, expect, it, vi } from 'vitest';
import { acknowledgeTerminalOutput } from './terminalAck';

afterEach(() => vi.unstubAllGlobals());

describe('terminal output acknowledgement', () => {
  it.each([
    { remote: true, ptyId: 'daemon-pty', usePort: false },
    { remote: true, ptyId: null, usePort: false },
    { remote: false, ptyId: 'local-pty', usePort: true },
    { remote: false, ptyId: null, usePort: false },
  ])('routes remote=$remote ptyId=$ptyId to the owning host', ({ remote, ptyId, usePort }) => {
    const ack = vi.fn();
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', { electronAPI: { ptyHost: { ack }, invoke } });
    acknowledgeTerminalOutput('panel-1', 5_000, ptyId, remote);
    if (usePort) {
      expect(ack).toHaveBeenCalledWith('local-pty', 5_000);
      expect(invoke).not.toHaveBeenCalled();
    } else {
      expect(invoke).toHaveBeenCalledWith('terminal:ack', 'panel-1', 5_000);
      expect(ack).not.toHaveBeenCalled();
    }
  });
});
