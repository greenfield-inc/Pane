import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartLinkAnswer, StartLinkRequest } from '../../../../shared/types/startLinks';
import { startStartLinkListener, useStartLinkStore } from './startLinkStore';

function request(requestId: string): StartLinkRequest {
  return {
    requestId,
    prompt: 'Fix the flaky login test',
    agents: [
      { id: 'claude', label: 'Claude Code', installed: true },
      { id: 'codex', label: 'Codex', installed: true },
    ],
    agent: 'claude',
    linkAgent: null,
    targets: [{ kind: 'new-session' }, { kind: 'repo', repoId: 7, repoName: 'acme-app', identity: 'github.com/acme/app' }],
  };
}

const answerStartLink = vi.fn(async (_answer: StartLinkAnswer) => undefined);
let emit: (request: StartLinkRequest) => void;
let stop: () => void;

beforeEach(() => {
  answerStartLink.mockClear();
  vi.stubGlobal('window', {
    electronAPI: {
      window: { answerStartLink },
      events: { onStartLinkRequest: (callback: typeof emit) => { emit = callback; return () => undefined; } },
    },
  });
  stop = startStartLinkListener();
});

afterEach(() => {
  stop();
  useStartLinkStore.setState({ request: null });
  vi.unstubAllGlobals();
});

describe('start link answers', () => {
  it('sends Start with the chosen agent and target once, then closes', () => {
    emit(request('r-1'));
    expect(useStartLinkStore.getState().request?.requestId).toBe('r-1');

    useStartLinkStore.getState().answer({ start: true, agent: 'codex', target: 1 });
    useStartLinkStore.getState().answer({ start: false });

    expect(answerStartLink.mock.calls).toEqual([[{ requestId: 'r-1', start: true, agent: 'codex', target: 1 }]]);
    expect(useStartLinkStore.getState().request).toBeNull();
  });

  it('answers the shown request Cancel before a newer one replaces it', () => {
    emit(request('r-1'));
    emit(request('r-2'));

    expect(answerStartLink.mock.calls).toEqual([[{ requestId: 'r-1', start: false }]]);
    expect(useStartLinkStore.getState().request?.requestId).toBe('r-2');
  });
});
