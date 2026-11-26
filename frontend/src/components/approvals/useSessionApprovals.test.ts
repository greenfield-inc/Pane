import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NotifyItem, NotifySnapshot } from '../../../../shared/types/notify';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../../shared/types/notify';
import { useNotifyStore } from '../../stores/notifyStore';
import { useApprovalColumnStore } from '../../stores/approvalColumnStore';
import { openNewSessionApprovals } from './useSessionApprovals';

function approval(id: string, createdAt: number, sessionId = 's1'): NotifyItem {
  return {
    id,
    ui: 'options',
    title: `${id}: Merge as one train?`,
    questions: [{ title: 'One train?', choices: [{ label: 'One train' }, { label: 'Gate each PR' }] }],
    source: { name: 'orchestrator', agent: 'Claude', paneId: 'sp', panelId: 'o1', session: { id: sessionId, name: 'Doozy', paneId: 'sp' } },
    state: 'waiting',
    createdAt,
    originKind: 'orchestrator',
  };
}

function snapshotOf(items: NotifyItem[]): NotifySnapshot {
  return {
    settings: DEFAULT_NOTIFY_SETTINGS, items, queue: items.map(item => item.id), hidden: [], strip: null, stripSurface: null, pausedUntil: null,
    shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [], cardsOn: { kind: 'any' }, thisMachine: null,
  };
}

const opened = () => useApprovalColumnStore.getState().open['session:s1']?.itemId;

describe('openNewSessionApprovals', () => {
  let stop: () => void = () => undefined;
  const old = approval('old', Date.now() - 60 * 60_000);

  beforeEach(() => {
    useApprovalColumnStore.setState({ open: {} });
    useNotifyStore.setState({ snapshot: snapshotOf([old]) });
  });
  afterEach(() => stop());

  it('opens an approval that arrives for the Session in its column', () => {
    stop = openNewSessionApprovals('s1');
    expect(opened()).toBeUndefined();

    useNotifyStore.setState({ snapshot: snapshotOf([old, approval('q7', Date.now())]) });

    expect(opened()).toBe('q7');
  });

  it('T-88: opens the newest of several approvals arriving together', () => {
    stop = openNewSessionApprovals('s1');
    const now = Date.now();
    useNotifyStore.setState({ snapshot: snapshotOf([old, approval('q7', now), approval('q8', now + 5)]) });

    expect(opened()).toBe('q8');
  });

  it('leaves an approval already open in the column alone, so a reply being typed stays', () => {
    stop = openNewSessionApprovals('s1');
    useApprovalColumnStore.getState().openApproval('session:s1', 'old');

    useNotifyStore.setState({ snapshot: snapshotOf([old, approval('q7', Date.now())]) });

    expect(opened()).toBe('old');
  });

  it('opens nothing for approvals that were waiting before, or that belong to another Session', () => {
    useNotifyStore.setState({ snapshot: null });
    stop = openNewSessionApprovals('s1');

    // The first snapshot, or another machine's list arriving late, brings items asked earlier.
    useNotifyStore.setState({ snapshot: snapshotOf([old, approval('other', Date.now(), 's2')]) });

    expect(opened()).toBeUndefined();
  });

  it('holds a worker question while its orchestrator may answer it, and opens it when relayed', () => {
    // Asked before the Session was shown; the orchestrator relays it afterwards.
    const blocked = { ...approval('w1', Date.now() - 5 * 60_000), quiet: true, originKind: 'worker' as const };
    useNotifyStore.setState({ snapshot: snapshotOf([old, blocked]) });
    stop = openNewSessionApprovals('s1');

    useNotifyStore.setState({ snapshot: snapshotOf([old, blocked, { ...approval('w2', Date.now()), quiet: true }]) });
    expect(opened()).toBeUndefined();

    useNotifyStore.setState({ snapshot: snapshotOf([old, { ...blocked, quiet: undefined }]) });
    expect(opened()).toBe('w1');
  });

  it("leaves the Session chat's own prompts to the chat, which already shows them", () => {
    stop = openNewSessionApprovals('s1', 'o1');

    useNotifyStore.setState({ snapshot: snapshotOf([old, { ...approval('b1', Date.now()), optionsOnly: true }]) });

    expect(opened()).toBeUndefined();
  });

  it('opens a new approval once: closed with ✕, it stays closed', () => {
    stop = openNewSessionApprovals('s1');
    const q7 = approval('q7', Date.now());
    useNotifyStore.setState({ snapshot: snapshotOf([old, q7]) });
    useApprovalColumnStore.getState().close('session:s1');

    useNotifyStore.setState({ snapshot: snapshotOf([old, { ...q7, version: 2 }]) });

    expect(opened()).toBeUndefined();
  });

  it('T-88 review S-1: an answer undone on another screen brings the caught-up column back to it', () => {
    stop = openNewSessionApprovals('s1');
    const q7 = approval('q7', Date.now());
    useNotifyStore.setState({ snapshot: snapshotOf([{ ...old, state: 'answered' }, { ...q7, state: 'sent' }]) });
    useApprovalColumnStore.getState().showCaughtUp('session:s1', 'q7');
    // A snapshot still showing it waiting (sent before the answer landed) doesn't bring it back.
    useNotifyStore.setState({ snapshot: snapshotOf([{ ...old, state: 'answered' }, q7]) });
    expect(useApprovalColumnStore.getState().open['session:s1']?.caughtUp).toBe(true);
    useNotifyStore.setState({ snapshot: snapshotOf([{ ...old, state: 'answered' }, { ...q7, state: 'sent' }]) });

    // Undo from the phone: the same card, same id and time, waits again.
    useNotifyStore.setState({ snapshot: snapshotOf([{ ...old, state: 'answered' }, q7]) });

    expect(useApprovalColumnStore.getState().open['session:s1']).toMatchObject({ itemId: 'q7' });
    expect(useApprovalColumnStore.getState().open['session:s1']?.caughtUp).toBeUndefined();
  });

  it('T-88 review S-1: an older approval updated while caught up opens in its place', () => {
    stop = openNewSessionApprovals('s1');
    useApprovalColumnStore.getState().showCaughtUp('session:s1', 'old');
    // Main's snapshot with the dismissal.
    useNotifyStore.setState({ snapshot: snapshotOf([{ ...old, dismissedAt: Date.now() }]) });
    expect(useApprovalColumnStore.getState().open['session:s1']?.caughtUp).toBe(true);

    // Its asker saved a new version: ready again, and no longer dismissed.
    useNotifyStore.setState({ snapshot: snapshotOf([{ ...old, version: 2, readyAgain: Date.now() }]) });

    expect(opened()).toBe('old');
    expect(useApprovalColumnStore.getState().open['session:s1']?.caughtUp).toBeUndefined();
  });

  it('T-88 review S-1: a reply the agent is reading leaves the column caught up', () => {
    stop = openNewSessionApprovals('s1');
    useApprovalColumnStore.getState().showCaughtUp('session:s1', 'old');
    useNotifyStore.setState({ snapshot: snapshotOf([{ ...old, reply: { id: 'r1', text: 'why?', at: Date.now(), state: 'reading' } }]) });

    expect(useApprovalColumnStore.getState().open['session:s1']?.caughtUp).toBe(true);
  });
});

