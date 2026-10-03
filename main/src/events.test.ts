import { describe, expect, it, vi } from 'vitest';
import type { Session } from './types/session';
import { handleSessionCreatedEvent } from './events';

function createSession(createDefaultTerminalOnCreate?: boolean): Session {
  return {
    id: 'session-1',
    name: 'Pane',
    worktreePath: '/repo',
    prompt: '',
    status: 'stopped',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    output: [],
    jsonMessages: [],
    archived: true,
    createDefaultTerminalOnCreate,
  };
}

describe('session-created event listener', () => {
  it('creates the default terminal when the flag is absent', async () => {
    const createPanel = vi.fn().mockResolvedValue({});

    await handleSessionCreatedEvent(createSession(), {
      send: vi.fn(),
      createPanel,
      refreshGitStatus: vi.fn().mockResolvedValue(null),
    });

    expect(createPanel).toHaveBeenCalledWith({
      sessionId: 'session-1',
      type: 'terminal',
      title: 'Terminal',
    });
  });

  it('skips the default terminal when createDefaultTerminalOnCreate is false', async () => {
    const createPanel = vi.fn().mockResolvedValue({});

    await handleSessionCreatedEvent(createSession(false), {
      send: vi.fn(),
      createPanel,
      refreshGitStatus: vi.fn().mockResolvedValue(null),
    });

    expect(createPanel).not.toHaveBeenCalled();
  });
});
