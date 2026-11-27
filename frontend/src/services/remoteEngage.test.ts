import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineSelectOutcome } from '../hooks/useMachines';
import type { LaunchDraft } from '../utils/launchOutline';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

const saveNavigationMemory = vi.fn(async () => ({ success: true }));
const keyListeners: Array<(event: KeyboardEvent) => void> = [];
const cancelSwitch = vi.fn(async () => ({ success: true, data: { cancelled: true } }));

/**
 * This computer and one of the owner's mirrored machines, "build", whose Session "b" has chat
 * tab "panel-b" in the mirror. `switchMachine` is the window's switch, as the sidebar sets it.
 */
async function setup(switchMachine: (machineId: string) => Promise<MachineSelectOutcome>, { online = true } = {}) {
  vi.resetModules();
  vi.stubGlobal('window', {
    addEventListener: vi.fn((type: string, listener: (event: KeyboardEvent) => void) => { if (type === 'keydown') keyListeners.push(listener); }),
    electronAPI: {
      uiState: { saveNavigationMemory, getPaneLayout: vi.fn(async () => ({ success: true, data: null })) },
      remoteDaemon: { cancelSwitch },
      machineMirror: { list: vi.fn(async () => []), session: vi.fn(async () => null), onChanged: vi.fn(() => () => undefined), followChat: vi.fn(), onChatEvent: vi.fn(() => () => undefined) },
      machines: { read: vi.fn(() => new Promise(() => undefined)), run: vi.fn() },
      chatTab: {},
    },
  });
  const { useAllMachinesStore } = await import('../stores/allMachinesStore');
  useAllMachinesStore.setState({
    entries: [
      { id: 'local', name: 'studio', os: 'macOS', slot: 0, letters: 'S', active: true },
      { id: 'build', name: 'Build box', os: 'macOS', slot: 1, letters: 'B', active: false },
    ],
    machines: [{ id: 'build', label: 'Build box', kind: 'remote', status: online ? 'online' : 'offline', offlineSince: online ? null : '2026-11-26T11:00:00.000Z', mine: true }],
    switchMachine,
  });
  const { useMachineMirrorStore } = await import('../stores/machineMirrorStore');
  useMachineMirrorStore.setState({ listings: { build: { state: { machineId: 'build', sync: online ? 'live' : 'offline', lastSeenAt: '2026-11-26T12:00:00.000Z', sessionCount: 1 }, sessions: { b: 4 } } } });
  const remote = await import('../stores/remoteSessionView');
  // SAFETY: engaging reads only the mirror copy's record name and chat tab id.
  remote.useRemoteSessionView.setState({ entries: { [remote.remoteSessionKey('build', 'b')]: { readAt: 0, snapshot: { session: { id: 'b', name: 'Release' }, chat: { panelId: 'panel-b', generation: 1, transcript: { panelId: 'panel-b', generation: 1, revision: 1, start: 0, messages: [] } } } as never } } });
  const { useOrchestrationSessionStore } = await import('../stores/orchestrationSessionStore');
  const landOn = vi.spyOn(useOrchestrationSessionStore.getState(), 'landOn');
  const { useErrorStore } = await import('../stores/errorStore');
  const engage = await import('./remoteEngage');
  const handover = await import('../utils/chatDraftHandover');
  const taken: LaunchDraft[] = [];
  const stopTaking = handover.acceptChatDraft('panel-b', draft => taken.push(draft));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return { engage, handover, landOn, taken, stopTaking, state: () => engage.useRemoteEngage.getState(), shownError: () => useErrorStore.getState().currentError };
}

const target = { machineId: 'build', sessionId: 'b' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  keyListeners.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a 1 s rest on another machine\'s Session engages it (T-132, D-2)', () => {
  it('starts exactly one switch, after the rest, landing quietly; none while the cursor keeps moving', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: true }));
    const { engage, landOn } = await setup(switchMachine);

    engage.armRestEngage(target);
    vi.advanceTimersByTime(600);
    engage.armRestEngage({ machineId: 'build', sessionId: 'c' });
    engage.armRestEngage(target);
    vi.advanceTimersByTime(999);
    await Promise.resolve();
    expect(switchMachine).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(switchMachine).toHaveBeenCalledTimes(1));
    expect(switchMachine).toHaveBeenCalledWith('build');
    // A rest does not resume a paused chat there (the #1777 rule).
    expect(landOn).toHaveBeenCalledWith('b', { quiet: true });
  });

  it('an arrow press before the rest ends starts no switch', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: true }));
    const { engage } = await setup(switchMachine);
    engage.armRestEngage(target);
    vi.advanceTimersByTime(900);
    engage.cancelRemoteEngage();
    vi.advanceTimersByTime(5000);
    expect(switchMachine).not.toHaveBeenCalled();
  });

  it('an arrow press during the switch cancels it, says nothing, and drops the landing (D-6)', async () => {
    const switched = deferred<MachineSelectOutcome>();
    const { engage, landOn, state, shownError } = await setup(() => switched.promise);
    engage.engageRemoteSession(target, 'rest');
    await vi.waitFor(() => expect(state().engaging).toMatchObject({ ...target, cause: 'rest' }));

    engage.cancelRemoteEngage();
    expect(state().engaging).toBeUndefined();
    expect(cancelSwitch).toHaveBeenCalledWith('build');
    switched.resolve({ ok: false, error: 'The switch to Build box was cancelled.' });
    await vi.runAllTimersAsync();
    expect(landOn).toHaveBeenLastCalledWith(undefined);
    expect(shownError()).toBeNull();
    expect(state().failure).toBeUndefined();
  });

  it('a machine that is offline is not switched to by a rest', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: true }));
    const { engage, state } = await setup(switchMachine, { online: false });
    engage.engageRemoteSession(target, 'rest');
    await vi.runAllTimersAsync();
    expect(switchMachine).not.toHaveBeenCalled();
    expect(state().engaging).toBeUndefined();
  });
});

describe('typing, Enter or a click engages, and what was typed arrives once (T-132)', () => {
  it('Enter or a click lands so a paused chat resumes, as Enter does today', async () => {
    const { engage, landOn } = await setup(async () => ({ ok: true }));
    engage.engageRemoteSession(target, 'click');
    await vi.waitFor(() => expect(landOn).toHaveBeenCalledWith('b', { quiet: false }));
  });

  it('holds what is typed through the switch and hands it to the chat there once it shows, once', async () => {
    const switched = deferred<MachineSelectOutcome>();
    const switchMachine = vi.fn(() => switched.promise);
    const { engage, handover, taken, state } = await setup(switchMachine);

    engage.holdRemoteText(target, 'h');
    engage.engageRemoteSession(target, 'type');
    engage.holdRemoteText(target, 'hello');
    engage.engageRemoteSession(target, 'type');
    await vi.waitFor(() => expect(switchMachine).toHaveBeenCalledTimes(1));
    // The mirror view stays on screen until the chat there paints.
    expect(state().engaging).toMatchObject({ ...target, cause: 'type', switched: false });

    switched.resolve({ ok: true });
    await vi.waitFor(() => expect(state().engaging?.switched).toBe(true));
    // The chat there paints at once from what the mirror held.
    const { chatTabViewer } = await import('../../../shared/chatTabViewer');
    // SAFETY: the stubbed window's chat client is the live client the module primes.
    expect(chatTabViewer(window.electronAPI.chatTab as never, 'panel-b').snapshot().view?.panelId).toBe('panel-b');
    expect(taken).toEqual([]);
    engage.holdRemoteText(target, 'hello there');
    handover.chatTabShown('panel-b');
    handover.chatTabShown('panel-b');

    expect(taken).toEqual([{ text: 'hello there', selectionStart: 11, selectionEnd: 11, focused: true, send: false }]);
    expect(state().engaging).toBeUndefined();
    expect(state().held[engage.engageKey(target)]).toBeUndefined();
  });

  it('a chat there that painted before the switch returned takes the text as soon as it does', async () => {
    const switched = deferred<MachineSelectOutcome>();
    const { engage, handover, taken, state } = await setup(() => switched.promise);
    engage.holdRemoteText(target, 'hello');
    engage.engageRemoteSession(target, 'type');
    // The restore drew the chat while the switch's call was still returning.
    handover.chatTabShown('panel-b');
    expect(taken).toEqual([]);
    switched.resolve({ ok: true });
    await vi.waitFor(() => expect(state().engaging).toBeUndefined());
    expect(taken).toEqual([expect.objectContaining({ text: 'hello', send: false })]);
  });

  it('Enter while the switch runs sends the held text there once, after the switch', async () => {
    const switched = deferred<MachineSelectOutcome>();
    const { engage, handover, taken } = await setup(() => switched.promise);
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    switched.resolve({ ok: true });
    await vi.waitFor(() => expect(engage.useRemoteEngage.getState().engaging?.switched).toBe(true));
    handover.chatTabShown('panel-b');
    expect(taken).toEqual([expect.objectContaining({ text: 'ship it', send: true })]);
  });

  it('a failed switch keeps the text unsent beside the reason, and sends nothing', async () => {
    const { engage, handover, taken, state, shownError } = await setup(async () => ({ ok: false, error: 'Build box stopped answering.' }));
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.waitFor(() => expect(state().failure).toBeDefined());

    expect(state().failure).toMatchObject({ ...target, message: 'Build box stopped answering.' });
    expect(state().engaging).toBeUndefined();
    // The text waits, no longer sending: Enter again tries again.
    expect(state().held[engage.engageKey(target)]).toEqual({ text: 'ship it', send: false });
    expect(shownError()).toBeNull();
    handover.chatTabShown('panel-b');
    expect(taken).toEqual([]);
  });

  it('an offline machine refuses with its reason and keeps the text, with no switch', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: true }));
    const { engage, state } = await setup(switchMachine, { online: false });
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.runAllTimersAsync();

    expect(switchMachine).not.toHaveBeenCalled();
    expect(state().failure?.message).toMatch(/Build box is offline/);
    expect(state().held[engage.engageKey(target)]).toEqual({ text: 'ship it', send: false });
  });

  it('an arrow press while typed text waits on the switch keeps the text for when the cursor comes back', async () => {
    const switched = deferred<MachineSelectOutcome>();
    const { engage, handover, taken, state } = await setup(() => switched.promise);
    engage.holdRemoteText(target, 'draft');
    engage.engageRemoteSession(target, 'type');
    engage.cancelRemoteEngage();
    switched.resolve({ ok: false, error: 'cancelled' });
    await vi.runAllTimersAsync();
    handover.chatTabShown('panel-b');
    expect(taken).toEqual([]);
    expect(state().held[engage.engageKey(target)]).toEqual({ text: 'draft', send: false });
  });

  it('lets go of the mirror view when the chat there never paints (a terminal Session), handing the text to it when it mounts', async () => {
    const { engage, handover, taken, stopTaking, state } = await setup(async () => ({ ok: true }));
    stopTaking();
    engage.holdRemoteText(target, 'later');
    engage.engageRemoteSession(target, 'type');
    await vi.waitFor(() => expect(state().engaging?.switched).toBe(true));
    await vi.advanceTimersByTimeAsync(engage.LIVE_VIEW_WAIT_MS);
    expect(state().engaging).toBeUndefined();
    handover.acceptChatDraft('panel-b', draft => taken.push(draft));
    expect(taken).toEqual([expect.objectContaining({ text: 'later' })]);
  });

  it('a key typed while the switch has left focus on nothing still goes into the held text', async () => {
    const switched = deferred<MachineSelectOutcome>();
    const { engage, state } = await setup(() => switched.promise);
    const body = {};
    vi.stubGlobal('document', { body, activeElement: body, querySelector: () => null });
    engage.holdRemoteText(target, 'ab');
    engage.engageRemoteSession(target, 'type');
    const preventDefault = vi.fn();
    // SAFETY: the listener reads only these fields of a keydown.
    for (const listener of keyListeners) listener({ key: 'c', metaKey: false, ctrlKey: false, altKey: false, isComposing: false, preventDefault } as unknown as KeyboardEvent);
    expect(state().held[engage.engageKey(target)]?.text).toBe('abc');
    expect(preventDefault).toHaveBeenCalled();
  });
});
