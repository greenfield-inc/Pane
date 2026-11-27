import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineSelectOutcome } from '../hooks/useMachines';
import type { LaunchDraft } from '../utils/launchOutline';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

const saveNavigationMemory = vi.fn(async () => ({ success: true }));
type KeyPress = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing' | 'preventDefault'>;
const keyListeners: Array<(event: KeyPress) => void> = [];
/** What the page's mousedown listeners read of a click. */
type MousePress = Pick<MouseEvent, 'target'>;
const mouseListeners: Array<(event: MousePress) => void> = [];
const cancelSwitch = vi.fn(async () => ({ success: true, data: { cancelled: true } }));

/**
 * This computer and one of the owner's mirrored machines, "build", whose Session "b" has chat
 * tab "panel-b" in the mirror. `switchMachine` is the window's switch, as the sidebar sets it.
 */
async function setup(switchMachine: (machineId: string) => Promise<MachineSelectOutcome>, { online = true } = {}) {
  vi.resetModules();
  vi.stubGlobal('window', {
    addEventListener: vi.fn((type: string, listener: (event: KeyPress | MousePress) => void) => {
      if (type === 'keydown') keyListeners.push(listener);
      if (type === 'mousedown') mouseListeners.push(listener);
    }),
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
  mouseListeners.length = 0;
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

    expect(taken).toEqual([{ text: 'hello there', selectionStart: 11, selectionEnd: 11, focused: true, send: false, sendBy: Date.now() + 60_000 }]);
    expect(state().engaging).toBeUndefined();
    expect(state().held[engage.engageKey(target)]).toBeUndefined();
    // The main area stays live while the restore under it finishes, at most 5 s.
    expect(state().settling).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(state().settling).toBe(false);
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
    vi.stubGlobal('document', { body, activeElement: body, querySelector: () => null, querySelectorAll: () => [] });
    engage.holdRemoteText(target, 'ab');
    engage.engageRemoteSession(target, 'type');
    const preventDefault = vi.fn();
    for (const listener of keyListeners) listener({ key: 'c', metaKey: false, ctrlKey: false, altKey: false, isComposing: false, preventDefault });
    expect(state().held[engage.engageKey(target)]?.text).toBe('abc');
    expect(preventDefault).toHaveBeenCalled();
  });
});

describe('an arrow just after an engage starts still cancels it (review 1781 SF-2)', () => {
  it('cancelled before main has a switch to stop: the window does not switch, and nothing lands', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: true }));
    const { engage, landOn } = await setup(switchMachine);
    const saving = deferred<{ success: boolean }>();
    saveNavigationMemory.mockImplementationOnce(() => saving.promise);
    // Main has no switch yet, so it has nothing to cancel.
    cancelSwitch.mockImplementationOnce(async () => ({ success: true, data: { cancelled: false } }));

    engage.engageRemoteSession(target, 'enter');
    await Promise.resolve();
    engage.cancelRemoteEngage();
    saving.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(10);

    expect(engage.useRemoteEngage.getState().engaging).toBeUndefined();
    expect(switchMachine).not.toHaveBeenCalled();
    expect(landOn).toHaveBeenLastCalledWith(undefined);
  });
});

describe('typed text is never lost (review 1781 SF-3)', () => {
  it('an arrow after the switch, before the chat there paints, hands the text to that chat unsent', async () => {
    const { engage, taken, state } = await setup(async () => ({ ok: true }));
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(state().engaging?.switched).toBe(true);

    engage.cancelRemoteEngage();
    await vi.advanceTimersByTimeAsync(5000);
    // The chat is opening there anyway: the text goes into its box, and the arrow means it is not sent.
    expect(taken).toEqual([expect.objectContaining({ text: 'ship it', send: false, focused: false })]);
    expect(state().held[engage.engageKey(target)]).toBeUndefined();
  });

  it('a Session the mirror holds no chat for does not take typing on its row (it keeps Enter)', async () => {
    const { engage } = await setup(async () => ({ ok: true }));
    expect(engage.takesTyping(target)).toBe(true);
    const remote = await import('../stores/remoteSessionView');
    // SAFETY: engaging reads only the record name and chat tab id; this Session has no chat in the mirror.
    remote.useRemoteSessionView.setState({ entries: { [remote.remoteSessionKey('build', 'b')]: { readAt: 0, snapshot: { session: { id: 'b', name: 'Release' } } as never } } });
    expect(engage.takesTyping(target)).toBe(false);
  });

  it('text that lands with no chat to take it stays held, with a note saying where it is', async () => {
    const { engage, taken, state } = await setup(async () => ({ ok: true }));
    const remote = await import('../stores/remoteSessionView');
    // SAFETY: engaging reads only the record name and chat tab id; this Session has no chat in the mirror.
    remote.useRemoteSessionView.setState({ entries: { [remote.remoteSessionKey('build', 'b')]: { readAt: 0, snapshot: { session: { id: 'b', name: 'Release' } } as never } } });
    engage.holdRemoteText(target, 'hello');
    engage.engageRemoteSession(target, 'type');
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(engage.LIVE_VIEW_WAIT_MS + 10);
    expect(state().engaging).toBeUndefined();
    expect(taken).toEqual([]);
    expect(state().held[engage.engageKey(target)]).toEqual({ text: 'hello', send: false });
    expect(state().failure).toMatchObject({ ...target, message: expect.stringMatching(/not sent/i) });
  });

  it('text that lands after the mirror learned the chat goes to that chat', async () => {
    const { engage, taken, state } = await setup(async () => ({ ok: true }));
    const remote = await import('../stores/remoteSessionView');
    const withChat = remote.useRemoteSessionView.getState().entries;
    // SAFETY: engaging reads only the record name and chat tab id; this Session has no chat in the mirror yet.
    remote.useRemoteSessionView.setState({ entries: { [remote.remoteSessionKey('build', 'b')]: { readAt: 0, snapshot: { session: { id: 'b', name: 'Release' } } as never } } });
    engage.holdRemoteText(target, 'hello');
    engage.engageRemoteSession(target, 'type');
    // The peek landed during the switch.
    remote.useRemoteSessionView.setState({ entries: withChat });
    await vi.advanceTimersByTimeAsync(engage.LIVE_VIEW_WAIT_MS + 20);
    expect(state().engaging).toBeUndefined();
    expect(taken).toEqual([expect.objectContaining({ text: 'hello' })]);
  });
});

describe('an engage settles once the window\'s connection is ready (review 1781 suggestion)', () => {
  it('a switch back to this computer settles at once; another machine once it says connected', async () => {
    const { engage } = await setup(async () => ({ ok: true }));
    expect(engage.engageSettled({ mode: 'local', status: 'local' }, 'connected')).toBe(true);
    expect(engage.engageSettled({ mode: 'remote', status: 'restoring' }, 'connected')).toBe(false);
    expect(engage.engageSettled({ mode: 'remote', status: 'connected' }, 'reconnecting')).toBe(false);
    expect(engage.engageSettled({ mode: 'remote', status: 'connected' }, 'connected')).toBe(true);
  });
});

describe('only a plain click into the chat engages it (review 1781 suggestion)', () => {
  const press = (extra: Partial<import('./remoteEngage').ClickPress> = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, inControl: false, ...extra });
  it('a plain left click with nothing selected engages; a selection, a right-click, a modifier or a control does not', async () => {
    const { clickEngages } = await import('./remoteEngage');
    expect(clickEngages(press(), '')).toBe(true);
    expect(clickEngages(press(), 'a line to copy')).toBe(false);
    expect(clickEngages(press({ button: 2 }), '')).toBe(false);
    expect(clickEngages(press({ metaKey: true }), '')).toBe(false);
    expect(clickEngages(press({ shiftKey: true }), '')).toBe(false);
    expect(clickEngages(press({ inControl: true }), '')).toBe(false);
  });
});

describe('a link cut as an engage starts never loses what was typed (QA 1781 F-1)', () => {
  it('a failed switch keeps the text visible with why, and the chat there takes it once, unsent, when it next opens live', async () => {
    const { engage, handover, stopTaking, state } = await setup(async () => ({ ok: false, error: 'Pane daemon not running on Build box.' }));
    stopTaking();
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.waitFor(() => expect(state().failure).toBeDefined());
    // The kept bar draws from these, over whatever the main area shows (the checklist).
    expect(engage.keptEngage(state())).toMatchObject({ ...target, text: 'ship it', message: 'Pane daemon not running on Build box.' });

    const taken: LaunchDraft[] = [];
    handover.acceptChatDraft('panel-b', draft => taken.push(draft));
    handover.acceptChatDraft('panel-b', draft => taken.push(draft));
    expect(taken).toEqual([expect.objectContaining({ text: 'ship it', send: false })]);
    expect(engage.keptEngage(state())).toBeUndefined();
  });

  it('on a dead link the hold stays, marked pending, instead of letting go after 3 s', async () => {
    const { engage, stopTaking, state } = await setup(async () => ({ ok: true }));
    stopTaking();
    engage.setEngageLinkUp(false);
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.waitFor(() => expect(state().engaging?.switched).toBe(true));
    await vi.advanceTimersByTimeAsync(engage.LIVE_VIEW_WAIT_MS * 3);
    expect(state().engaging).toMatchObject({ ...target, waiting: true });
    expect(state().held[engage.engageKey(target)]?.text).toBe('ship it');
  });

  it('the link back and the chat there painting sends an Enter pressed meanwhile exactly once', async () => {
    const { engage, handover, taken, state } = await setup(async () => ({ ok: true }));
    engage.setEngageLinkUp(false);
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.waitFor(() => expect(state().engaging?.switched).toBe(true));
    await vi.advanceTimersByTimeAsync(engage.LIVE_VIEW_WAIT_MS * 3);
    expect(taken).toEqual([]);
    engage.setEngageLinkUp(true);
    handover.chatTabShown('panel-b');
    handover.chatTabShown('panel-b');
    expect(taken).toEqual([expect.objectContaining({ text: 'ship it', send: true })]);
    expect(state().engaging).toBeUndefined();
  });

  it('an arrow while it waits on a dead link keeps the text visible, pending, and the chat takes it once, unsent, when it opens', async () => {
    const { engage, handover, stopTaking, state } = await setup(async () => ({ ok: true }));
    stopTaking();
    engage.setEngageLinkUp(false);
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.waitFor(() => expect(state().engaging?.switched).toBe(true));
    await vi.advanceTimersByTimeAsync(engage.LIVE_VIEW_WAIT_MS * 3);
    engage.cancelRemoteEngage();
    expect(engage.keptEngage(state())).toMatchObject({ ...target, text: 'ship it', pending: true });

    const taken: LaunchDraft[] = [];
    handover.acceptChatDraft('panel-b', draft => taken.push(draft));
    handover.acceptChatDraft('panel-b', draft => taken.push(draft));
    // The arrow moved on, so it is not sent: it goes into that chat's box once, marked not sent yet.
    expect(taken).toEqual([expect.objectContaining({ text: 'ship it', send: false, note: expect.stringMatching(/not sent yet/i) })]);
    expect(engage.keptEngage(state())).toBeUndefined();
  });

  it('Enter in the kept bar once the window is on that machine opens the Session there and sends once', async () => {
    const { engage, handover, stopTaking, state } = await setup(async () => ({ ok: false, error: 'Build box stopped answering.' }));
    stopTaking();
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'type');
    await vi.waitFor(() => expect(state().failure).toBeDefined());
    const { useAllMachinesStore } = await import('../stores/allMachinesStore');
    useAllMachinesStore.setState(current => ({ entries: current.entries.map(entry => ({ ...entry, active: entry.id === 'build' })) }));

    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.advanceTimersByTimeAsync(10);
    const taken: LaunchDraft[] = [];
    handover.acceptChatDraft('panel-b', draft => taken.push(draft));
    expect(taken).toEqual([expect.objectContaining({ text: 'ship it', send: true })]);
  });
});

describe('a dial that hangs on a dead link says it is pending (QA 1781 F-1)', () => {
  it('marks the hold not sent yet once the dial has taken LIVE_VIEW_WAIT_MS, and clears it when the switch lands', async () => {
    const switched = deferred<MachineSelectOutcome>();
    const { engage, state } = await setup(() => switched.promise);
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.advanceTimersByTimeAsync(engage.LIVE_VIEW_WAIT_MS - 10);
    expect(state().engaging?.waiting).toBeFalsy();
    await vi.advanceTimersByTimeAsync(20);
    expect(state().engaging).toMatchObject({ switched: false, waiting: true });
    switched.resolve({ ok: true });
    await vi.waitFor(() => expect(state().engaging?.switched).toBe(true));
    expect(state().engaging?.waiting).toBeFalsy();
  });
});

describe('an Enter whose minute passes on a dead link says so, and never sends late (QA 1781 F-2, D-22)', () => {
  it('at 60 s the held text stops sending and says why; landing later hands it over unsent with the same reason', async () => {
    const { engage, handover, stopTaking, state } = await setup(async () => ({ ok: true }));
    stopTaking();
    engage.setEngageLinkUp(false);
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.waitFor(() => expect(state().engaging?.switched).toBe(true));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(state().held[engage.engageKey(target)]).toMatchObject({ send: true });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(state().held[engage.engageKey(target)]).toMatchObject({ text: 'ship it', send: false, notSent: 'Not sent: Build box didn\'t answer within a minute. Press Enter to send.' });

    engage.setEngageLinkUp(true);
    const taken: LaunchDraft[] = [];
    handover.acceptChatDraft('panel-b', draft => taken.push(draft));
    handover.chatTabShown('panel-b');
    expect(taken).toEqual([expect.objectContaining({ text: 'ship it', send: false, note: 'Not sent: Build box didn\'t answer within a minute. Press Enter to send.' })]);
  });

  it('Enter again after that sends it when the chat there can', async () => {
    const { engage, handover, taken, state } = await setup(async () => ({ ok: true }));
    engage.setEngageLinkUp(false);
    engage.holdRemoteText(target, 'ship it');
    engage.engageRemoteSession(target, 'enter', { send: true });
    await vi.waitFor(() => expect(state().engaging?.switched).toBe(true));
    await vi.advanceTimersByTimeAsync(61_000);
    engage.engageRemoteSession(target, 'enter', { send: true });
    expect(state().held[engage.engageKey(target)]).toMatchObject({ send: true });
    expect(state().held[engage.engageKey(target)]?.notSent).toBeUndefined();
    engage.setEngageLinkUp(true);
    handover.chatTabShown('panel-b');
    expect(taken).toEqual([expect.objectContaining({ text: 'ship it', send: true })]);
  });
});

describe('an arrow that comes after main committed the switch (QA 1781 F-3)', () => {
  async function tooLate() {
    const switchMachine = vi.fn(async (machineId: string): Promise<MachineSelectOutcome> => {
      const { useAllMachinesStore } = await import('../stores/allMachinesStore');
      useAllMachinesStore.setState(current => ({ entries: current.entries.map(entry => ({ ...entry, active: entry.id === machineId })) }));
      return { ok: true };
    });
    const ctx = await setup(switchMachine);
    const landing = deferred<{ success: boolean }>();
    saveNavigationMemory.mockImplementationOnce(() => landing.promise);
    // Main already committed it: the cancel can't stop it.
    cancelSwitch.mockImplementationOnce(async () => ({ success: true, data: { cancelled: false, outcome: 'committed' } }));
    return { ...ctx, switchMachine, landing };
  }

  it('the window goes back, once, to the machine of the row the cursor moved to', async () => {
    const { engage, switchMachine } = await tooLate();
    engage.engageRemoteSession(target, 'rest');
    await vi.waitFor(() => expect(saveNavigationMemory).toHaveBeenCalled());
    // The open is already past the point a cancel stops (its switch call went out).
    saveNavigationMemory.mockClear();
    const { useAllMachinesStore } = await import('../stores/allMachinesStore');
    useAllMachinesStore.setState(current => ({ entries: current.entries.map(entry => ({ ...entry, active: entry.id === 'build' })) }));
    engage.cancelRemoteEngage({ machineId: 'local', sessionId: 'a1' });
    await vi.advanceTimersByTimeAsync(50);
    expect(switchMachine.mock.calls.map(call => call[0])).toEqual(['local']);
  });

  it('a cursor still on that machine\'s rows keeps the window there', async () => {
    const { engage, switchMachine } = await tooLate();
    engage.engageRemoteSession(target, 'rest');
    await vi.waitFor(() => expect(saveNavigationMemory).toHaveBeenCalled());
    const { useAllMachinesStore } = await import('../stores/allMachinesStore');
    useAllMachinesStore.setState(current => ({ entries: current.entries.map(entry => ({ ...entry, active: entry.id === 'build' })) }));
    engage.cancelRemoteEngage({ machineId: 'build', sessionId: 'c' });
    await vi.advanceTimersByTimeAsync(50);
    expect(switchMachine).not.toHaveBeenCalled();
  });
});

describe('the return after a cancel main could not stop (review 1781 R4-MF-1, R4-SF-1)', () => {
  async function activate(machineId: string) {
    const { useAllMachinesStore } = await import('../stores/allMachinesStore');
    useAllMachinesStore.setState(current => ({ entries: current.entries.map(entry => ({ ...entry, active: entry.id === machineId })) }));
  }

  it('main had nothing to stop: no return, so the person\'s own later switch stands', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: true }));
    const { engage } = await setup(switchMachine);
    const saving = deferred<{ success: boolean }>();
    saveNavigationMemory.mockImplementationOnce(() => saving.promise);
    cancelSwitch.mockImplementationOnce(async () => ({ success: true, data: { cancelled: false, outcome: 'nothing' } }));
    engage.engageRemoteSession(target, 'rest');
    await Promise.resolve();
    engage.cancelRemoteEngage({ machineId: 'local', sessionId: 'a1' });
    saving.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(4000);
    await activate('build');
    await vi.advanceTimersByTimeAsync(50);
    expect(switchMachine).not.toHaveBeenCalled();
  });

  it('a committed switch returns once, and never again however the window moves after', async () => {
    const switchMachine = vi.fn(async (machineId: string): Promise<MachineSelectOutcome> => { await activate(machineId); return { ok: true }; });
    const { engage } = await setup(switchMachine);
    const landing = deferred<{ success: boolean }>();
    saveNavigationMemory.mockImplementationOnce(() => landing.promise);
    cancelSwitch.mockImplementationOnce(async () => ({ success: true, data: { cancelled: false, outcome: 'committed' } }));
    engage.engageRemoteSession(target, 'rest');
    await vi.waitFor(() => expect(saveNavigationMemory).toHaveBeenCalled());
    await activate('build');
    engage.cancelRemoteEngage({ machineId: 'local', sessionId: 'a1' });
    await vi.advanceTimersByTimeAsync(50);
    expect(switchMachine.mock.calls.map(call => call[0])).toEqual(['local']);
    await activate('build');
    await vi.advanceTimersByTimeAsync(50);
    await activate('local');
    await activate('build');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(switchMachine.mock.calls.map(call => call[0])).toEqual(['local']);
  });

  it('the cancel answers before the window lands: one return when it does, with no recursion', async () => {
    const switchMachine = vi.fn(async (_machineId: string): Promise<MachineSelectOutcome> => ({ ok: true }));
    const { engage, landOn } = await setup(switchMachine);
    cancelSwitch.mockImplementationOnce(async () => ({ success: true, data: { cancelled: false, outcome: 'committed' } }));
    engage.engageRemoteSession(target, 'rest');
    await vi.waitFor(() => expect(saveNavigationMemory).toHaveBeenCalled());
    engage.cancelRemoteEngage({ machineId: 'local', sessionId: 'a1' });
    await vi.advanceTimersByTimeAsync(10);
    landOn.mockClear();
    await activate('build');
    await vi.advanceTimersByTimeAsync(50);
    expect(landOn).toHaveBeenCalledTimes(1);
    expect(switchMachine.mock.calls.map(call => call[0])).toEqual(['local']);
  });

  it('a newer press of any row before the window lands drops the return', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: true }));
    const { engage } = await setup(switchMachine);
    cancelSwitch.mockImplementationOnce(async () => ({ success: true, data: { cancelled: false, outcome: 'committed' } }));
    engage.engageRemoteSession(target, 'rest');
    await vi.waitFor(() => expect(saveNavigationMemory).toHaveBeenCalled());
    engage.cancelRemoteEngage({ machineId: 'local', sessionId: 'a1' });
    await vi.advanceTimersByTimeAsync(10);
    // The person opens a row themselves (a click or Enter, not an engage).
    const { openOnMachine } = await import('../utils/machineRowActions');
    void openOnMachine('build', { kind: 'session', id: 'c', name: 'Other' });
    await vi.advanceTimersByTimeAsync(10);
    switchMachine.mockClear();
    await activate('build');
    await vi.advanceTimersByTimeAsync(50);
    expect(switchMachine).not.toHaveBeenCalled();
  });

  it('a newer switch from the machine switcher drops the return too', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: true }));
    const { engage } = await setup(switchMachine);
    cancelSwitch.mockImplementationOnce(async () => ({ success: true, data: { cancelled: false, outcome: 'committed' } }));
    engage.engageRemoteSession(target, 'rest');
    await vi.waitFor(() => expect(saveNavigationMemory).toHaveBeenCalled());
    engage.cancelRemoteEngage({ machineId: 'local', sessionId: 'a1' });
    await vi.advanceTimersByTimeAsync(10);
    const { requestMachinePress } = await import('../hooks/useMachines');
    void requestMachinePress({ id: 'build', kind: 'computer', action: 'switch', computerId: 'build' }, async () => ({ ok: true }));
    switchMachine.mockClear();
    await activate('build');
    await vi.advanceTimersByTimeAsync(50);
    expect(switchMachine).not.toHaveBeenCalled();
  });
});

describe('an arrow stops the return\'s own switch (review 1781 round 4)', () => {
  it('the return\'s open has not reached its switch: an arrow means it never switches', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: true }));
    const { engage } = await setup(switchMachine);
    cancelSwitch.mockImplementationOnce(async () => ({ success: true, data: { cancelled: false, outcome: 'committed' } }));
    engage.engageRemoteSession(target, 'rest');
    await vi.waitFor(() => expect(saveNavigationMemory).toHaveBeenCalled());
    const { useAllMachinesStore } = await import('../stores/allMachinesStore');
    useAllMachinesStore.setState(current => ({ entries: current.entries.map(entry => ({ ...entry, active: entry.id === 'build' })) }));
    // The return's own open waits to remember the row.
    const remembering = deferred<{ success: boolean }>();
    saveNavigationMemory.mockImplementationOnce(() => remembering.promise);
    engage.cancelRemoteEngage({ machineId: 'local', sessionId: 'a1' });
    await vi.advanceTimersByTimeAsync(10);
    switchMachine.mockClear();
    engage.cancelRemoteEngage({ machineId: 'build', sessionId: 'c' });
    remembering.resolve({ success: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(switchMachine).not.toHaveBeenCalled();
  });
});

describe('a switch that fails while the person types keeps every key (QA 1781, M-280)', () => {
  it('keys landing on the page after the failure go into the kept text; Enter on the page does not retry', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: false, error: 'Build box answered 503.' }));
    const { engage, state } = await setup(switchMachine);
    const body = {};
    vi.stubGlobal('document', { body, activeElement: body, querySelector: () => null, querySelectorAll: () => [] });
    engage.holdRemoteText(target, 'qa-');
    engage.engageRemoteSession(target, 'type');
    await vi.waitFor(() => expect(state().failure).toBeDefined());
    // The kept bar takes focus as it draws.
    expect(state().keptFocus).toBe(true);
    const preventDefault = vi.fn();
    const press = (key: string) => { for (const listener of keyListeners) listener({ key, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, preventDefault }); };
    for (const key of 'check') press(key);
    expect(state().held[engage.engageKey(target)]?.text).toBe('qa-check');
    // Enter on the page doesn't retry (review 1781 R6-SF-1): only Enter in the focused kept bar does.
    press('Enter');
    await vi.advanceTimersByTimeAsync(50);
    expect(switchMachine).toHaveBeenCalledTimes(1);
  });

  it('a failure the person was not typing into takes no keys and no focus', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: false, error: 'Build box answered 503.' }));
    const { engage, state } = await setup(switchMachine);
    const body = {};
    vi.stubGlobal('document', { body, activeElement: body, querySelector: () => null, querySelectorAll: () => [] });
    engage.holdRemoteText(target, 'qa-');
    engage.engageRemoteSession(target, 'click');
    await vi.waitFor(() => expect(state().failure).toBeDefined());
    expect(state().keptFocus).toBeFalsy();
    const preventDefault = vi.fn();
    for (const listener of keyListeners) listener({ key: 'x', metaKey: false, ctrlKey: false, altKey: false, isComposing: false, preventDefault });
    expect(state().held[engage.engageKey(target)]?.text).toBe('qa-');
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('the kept bar takes keys only until the person moves on (review 1781 R6-SF-1)', () => {
  it('a click anywhere else hands the keys back: a key and an Enter meant for a card reach the card', async () => {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: false, error: 'Build box answered 503.' }));
    const { engage, state } = await setup(switchMachine);
    const body = {};
    vi.stubGlobal('document', { body, activeElement: body, querySelector: () => null, querySelectorAll: () => [] });
    engage.holdRemoteText(target, 'qa-');
    engage.engageRemoteSession(target, 'type');
    await vi.waitFor(() => expect(state().failure).toBeDefined());
    // A click on something that takes no focus: mousedown fires, focus stays on the page.
    for (const listener of mouseListeners) listener({ target: null });
    const cardTook: string[] = [];
    keyListeners.push(event => { cardTook.push(event.key); });
    const preventDefault = vi.fn();
    for (const key of ['1', 'Enter']) for (const listener of [...keyListeners]) listener({ key, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, preventDefault });
    await vi.advanceTimersByTimeAsync(50);
    expect({ cardTook, kept: state().held[engage.engageKey(target)]?.text, switches: switchMachine.mock.calls.length }).toEqual({ cardTook: ['1', 'Enter'], kept: 'qa-', switches: 1 });
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('only a modal that is shown stops the kept bar taking keys (review 1781 round 7)', () => {
  /** What the kept-key path reads of an element in the page: whether it takes up any room. */
  interface PageElement { role: string; getClientRects: () => Array<{ width: number; height: number }> }
  async function failed(page: { querySelector: (selector: string) => PageElement | null; querySelectorAll: (selector: string) => PageElement[] }) {
    const switchMachine = vi.fn(async (): Promise<MachineSelectOutcome> => ({ ok: false, error: 'Build box answered 503.' }));
    const ctx = await setup(switchMachine);
    const body = {};
    vi.stubGlobal('document', { body, activeElement: body, ...page });
    ctx.engage.holdRemoteText(target, 'qa-');
    ctx.engage.engageRemoteSession(target, 'type');
    await vi.waitFor(() => expect(ctx.state().failure).toBeDefined());
    const preventDefault = vi.fn();
    for (const key of 'check') for (const listener of keyListeners) listener({ key, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, preventDefault });
    return ctx.state().held[ctx.engage.engageKey(target)]?.text;
  }

  it('a hidden Review tab\'s listbox mounted in the page does not', async () => {
    // The Changes list stays mounted behind display:none (PanelGroupView keeps diff panels alive).
    const changesList = { role: 'listbox', getClientRects: () => [] };
    const matches = (selector: string) => (selector.includes('listbox') ? [changesList] : []);
    expect(await failed({ querySelector: selector => matches(selector)[0] ?? null, querySelectorAll: matches })).toBe('qa-check');
  });

  it('a hidden dialog does not either', async () => {
    const dialog = { role: 'dialog', getClientRects: () => [] };
    const matches = (selector: string) => (selector.includes('dialog') ? [dialog] : []);
    expect(await failed({ querySelector: selector => matches(selector)[0] ?? null, querySelectorAll: matches })).toBe('qa-check');
  });

  it('a dialog that is shown does: its keys stay its own', async () => {
    const dialog = { role: 'dialog', getClientRects: () => [{ width: 400, height: 300 }] };
    const matches = (selector: string) => (selector.includes('dialog') ? [dialog] : []);
    expect(await failed({ querySelector: selector => matches(selector)[0] ?? null, querySelectorAll: matches })).toBe('qa-');
  });
});
