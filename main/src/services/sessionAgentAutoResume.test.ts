import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '../../../shared/types/agentStatus';
import {
  API_ERROR_BACKOFF_MS,
  SessionAgentAutoResume,
  nudgeText,
  transientApiError,
  type AutoResumeEntry,
  type AutoResumeScreen,
  type AutoResumeWorker,
  type SessionAgentAutoResumeDependencies,
} from './sessionAgentAutoResume';

const worker: AutoResumeWorker = {
  panelId: 'panel-1', paneId: 'pane-1', panelTitle: 'Claude', agentType: 'claude', interruptedAt: '2026-10-17T16:58:12.345Z',
};
const emptyComposer: AutoResumeScreen = { text: '> ', composerPresent: true, composerHasText: false };
const apiErrorScreen: AutoResumeScreen = {
  text: '● Running the tests\n  ⎿  API Error: Connection error.\n\n> \n  ? for shortcuts',
  composerPresent: true,
  composerHasText: false,
};

function setup(overrides: Partial<SessionAgentAutoResumeDependencies> = {}) {
  const records: AutoResumeEntry[] = [];
  const submitted: Array<{ panelId: string; text: string }> = [];
  const states = new Map<string, AgentState>();
  let screen = emptyComposer;
  const dependencies: SessionAgentAutoResumeDependencies = {
    isEnabled: () => true,
    listStoppedWorkers: async () => [worker],
    listRunningWorkers: () => [],
    worker: panelId => panelId === worker.panelId ? worker : undefined,
    resume: vi.fn(async () => ({ ready: true, blocked: false })),
    agentState: panelId => states.get(panelId),
    readScreen: async () => screen,
    submit: vi.fn(async (panelId: string, text: string) => { submitted.push({ panelId, text }); return true; }),
    record: entry => records.push(entry),
    log: () => {},
    ...overrides,
  };
  const autoResume = new SessionAgentAutoResume(dependencies);
  return {
    autoResume, dependencies, records, submitted, states,
    setScreen: (next: AutoResumeScreen) => { screen = next; },
  };
}

describe('transientApiError', () => {
  it.each([
    'API Error: Connection error.',
    'API Error: Request timed out.',
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
    'API Error (500 Internal server error)',
    'Your computer went to sleep mid-response',
    "Can't reach the API server",
    'getaddrinfo ENOTFOUND api.anthropic.com',
    '■ stream disconnected before completion: error sending request for url',
  ])('recognises %s', line => {
    expect(transientApiError(`Working on it\n${line}\n> `)).toBe(line);
  });

  it.each([
    'API Error: 401 {"type":"authentication_error"}',
    'API Error: 400 prompt is too long',
    "You've hit your usage limit",
    'All tests passed.',
  ])('does not treat %s as transient', line => {
    expect(transientApiError(`${line}\n> `)).toBeUndefined();
  });

  it('reads only the last lines of the screen, where the turn ended', () => {
    const old = ['API Error: Connection error.', ...Array.from({ length: 20 }, (_, index) => `line ${index}`)].join('\n');
    expect(transientApiError(old)).toBeUndefined();
  });
});

describe('nudgeText', () => {
  it('names when the agent was interrupted', () => {
    expect(nudgeText('2026-10-17T16:58:12.345Z')).toBe("You were interrupted at 2026-10-17T16:58:12Z. Re-read your task's status and continue.");
    expect(nudgeText(undefined)).toBe("You were interrupted at an unknown time. Re-read your task's status and continue.");
  });
});

describe('SessionAgentAutoResume', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-10-17T17:00:00Z') }));
  afterEach(() => vi.useRealTimers());

  it('resumes the workers Pane stopped, nudges each once, and records panel.resumed', async () => {
    const { autoResume, dependencies, records, submitted } = setup();
    autoResume.captureStartupWorkers();
    await autoResume.resumeStartupWorkers();

    expect(dependencies.resume).toHaveBeenCalledWith('panel-1');
    expect(submitted).toEqual([{ panelId: 'panel-1', text: nudgeText(worker.interruptedAt) }]);
    expect(records).toEqual([expect.objectContaining({
      kind: 'panel.resumed', paneId: 'pane-1', panelId: 'panel-1', source: 'session',
      reason: 'pane-start', nudged: true, interruptedAt: worker.interruptedAt,
    })]);
  });

  it('lists the stopped workers at capture time, before the app can start them', async () => {
    let stopped = [worker];
    const { autoResume, submitted } = setup({ listStoppedWorkers: async () => stopped });
    autoResume.captureStartupWorkers();
    stopped = [];
    await autoResume.resumeStartupWorkers();
    expect(submitted).toHaveLength(1);
  });

  it('never types into a composer that holds unsent text', async () => {
    const { autoResume, records, submitted, setScreen } = setup();
    setScreen({ text: '> half a sentence', composerPresent: true, composerHasText: true });
    autoResume.captureStartupWorkers();
    await autoResume.resumeStartupWorkers();
    expect(submitted).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ reason: 'pane-start', nudged: false, heldInputPresent: true })]);
  });

  it('does not nudge an agent that comes back waiting on a person', async () => {
    const { autoResume, records, submitted } = setup({ resume: async () => ({ ready: true, blocked: true }) });
    autoResume.captureStartupWorkers();
    await autoResume.resumeStartupWorkers();
    expect(submitted).toEqual([]);
    expect(records).toEqual([expect.objectContaining({ nudged: false, to: 'blocked' })]);
  });

  it('does nothing when the setting is off', async () => {
    const { autoResume, dependencies, records } = setup({ isEnabled: () => false });
    autoResume.captureStartupWorkers();
    await autoResume.resumeStartupWorkers();
    autoResume.handleAgentStatus('panel-1', 'idle', 'idle_prompt');
    await vi.runAllTimersAsync();
    expect(dependencies.resume).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('logs and records nothing when the resume fails', async () => {
    const log = vi.fn();
    const { autoResume, records } = setup({ resume: async () => { throw new Error('spawn failed'); }, log });
    autoResume.captureStartupWorkers();
    await autoResume.resumeStartupWorkers();
    expect(records).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('panel-1'), expect.any(Error));
  });

  describe('a turn that ends on a transient API error', () => {
    it('is nudged after a backoff, then again with longer waits, at most three times an hour', async () => {
      const { autoResume, records, submitted, states, setScreen } = setup();
      setScreen(apiErrorScreen);
      states.set('panel-1', 'idle');

      for (const [index, wait] of API_ERROR_BACKOFF_MS.entries()) {
        autoResume.handleAgentStatus('panel-1', 'idle', 'idle_prompt');
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(submitted).toHaveLength(index);
        await vi.advanceTimersByTimeAsync(1);
        expect(submitted).toHaveLength(index + 1);
        expect(records.at(-1)).toEqual(expect.objectContaining({ reason: 'api-error', nudged: true, attempt: index + 1 }));
      }

      autoResume.handleAgentStatus('panel-1', 'idle', 'idle_prompt');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(submitted).toHaveLength(3);

      // The hour rolls over and the count starts again.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      autoResume.handleAgentStatus('panel-1', 'idle', 'idle_prompt');
      await vi.advanceTimersByTimeAsync(API_ERROR_BACKOFF_MS[0]);
      expect(submitted).toHaveLength(4);
    });

    it('is left alone when the agent starts working again during the backoff', async () => {
      const { autoResume, submitted, states, setScreen } = setup();
      setScreen(apiErrorScreen);
      states.set('panel-1', 'idle');
      autoResume.handleAgentStatus('panel-1', 'idle', 'idle_prompt');
      await vi.advanceTimersByTimeAsync(1_000);
      autoResume.handleAgentStatus('panel-1', 'working', 'spinner');
      await vi.advanceTimersByTimeAsync(API_ERROR_BACKOFF_MS[0]);
      expect(submitted).toEqual([]);
    });

    it('is not nudged when someone typed into its composer during the backoff', async () => {
      const { autoResume, records, submitted, states, setScreen } = setup();
      setScreen(apiErrorScreen);
      states.set('panel-1', 'idle');
      autoResume.handleAgentStatus('panel-1', 'idle', 'idle_prompt');
      setScreen({ ...apiErrorScreen, composerHasText: true });
      await vi.advanceTimersByTimeAsync(API_ERROR_BACKOFF_MS[0]);
      expect(submitted).toEqual([]);
      expect(records).toEqual([expect.objectContaining({ reason: 'api-error', nudged: false, heldInputPresent: true })]);
    });

    it('ignores turns that end normally and panels that are not Session workers', async () => {
      const { autoResume, submitted, states, setScreen } = setup();
      states.set('panel-1', 'idle');
      states.set('other', 'idle');
      autoResume.handleAgentStatus('panel-1', 'idle', 'idle_prompt');
      setScreen(apiErrorScreen);
      autoResume.handleAgentStatus('other', 'idle', 'idle_prompt');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(submitted).toEqual([]);
    });
  });

  describe('after the computer wakes', () => {
    it('restarts stopped workers and nudges idle ones whose turn died while asleep', async () => {
      const running: AutoResumeWorker = { panelId: 'panel-2', paneId: 'pane-2' };
      const screens = new Map<string, AutoResumeScreen>([['panel-1', emptyComposer], ['panel-2', apiErrorScreen]]);
      const { autoResume, records, submitted, states } = setup({
        listRunningWorkers: () => [running],
        worker: panelId => panelId === 'panel-2' ? running : panelId === 'panel-1' ? worker : undefined,
        readScreen: async panelId => screens.get(panelId) ?? emptyComposer,
      });
      states.set('panel-2', 'idle');

      autoResume.handleSuspend();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      autoResume.handleSystemResume();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(records).toEqual([expect.objectContaining({
        panelId: 'panel-1', reason: 'system-resume', nudged: true, interruptedAt: '2026-10-17T17:00:00.000Z',
      })]);
      await vi.advanceTimersByTimeAsync(API_ERROR_BACKOFF_MS[0]);
      expect(submitted.map(item => item.panelId)).toEqual(['panel-1', 'panel-2']);
      expect(records.at(-1)).toEqual(expect.objectContaining({ panelId: 'panel-2', reason: 'api-error', attempt: 1 }));
    });
  });
});
