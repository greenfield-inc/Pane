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

  it('opens a new approval once: closed with ✕, it stays closed', () => {
    stop = openNewSessionApprovals('s1');
    const q7 = approval('q7', Date.now());
    useNotifyStore.setState({ snapshot: snapshotOf([old, q7]) });
    useApprovalColumnStore.getState().close('session:s1');

    useNotifyStore.setState({ snapshot: snapshotOf([old, { ...q7, version: 2 }]) });

    expect(opened()).toBeUndefined();
  });
});
