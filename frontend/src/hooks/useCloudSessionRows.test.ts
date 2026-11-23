import { describe, expect, it } from 'vitest';
import { cloudSessionRows, type MachineLists } from './useCloudSessionRows';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import type { PaneCloudSession } from '../../../shared/types/paneCloud';

// SAFETY: the rows read only id, name, archived, isPinned and todoNumber from a record.
const record = (fields: Partial<OrchestrationSessionRecord> & { id: string; name: string }) => fields as OrchestrationSessionRecord;

const vm = (fields: Partial<PaneCloudSession> & { vmId: string; name: string }): PaneCloudSession => ({
  awake: true, underReview: false, machineId: null, paneVersion: '2.4.249', createdAt: '2026-11-20T10:00:00.000Z', ...fields,
});

const lists = {
  local: {
    sessions: [
      record({ id: 'legacy-pane-chat', name: 'Pane Chat' }),
      record({ id: 'checkout', name: 'Checkout redesign', isPinned: true }),
      record({ id: 'todo-7', name: 'T-7 Fix the footer', todoNumber: 7 }),
      record({ id: 'old', name: 'Old work', archived: true }),
      record({ id: 'hourly', name: 'Hourly triage' }),
    ],
    activity: [{ sessionId: 'checkout', state: 'working', workingPanes: 2 }],
    loopSessionIds: ['hourly'],
  },
  'cloud-1': {
    sessions: [
      record({ id: 'legacy-pane-chat', name: 'Onboarding' }),
      record({ id: 'docs', name: 'Docs site migration' }),
      record({ id: 'todo-9', name: 'T-9 Update the README', todoNumber: 9 }),
    ],
    activity: [],
    loopSessionIds: [],
  },
} satisfies Record<string, MachineLists>;

const names = (rows: ReturnType<typeof cloudSessionRows>) => rows.map((row) => row.name);

describe('the Sessions list rows for other machines', () => {
  it('on this computer: lists a cloud Session without its machine\'s own Pane Chat or to-do Sessions', () => {
    const rows = cloudSessionRows({ cloud: { sessions: [vm({ vmId: 'vm-1', name: 'Docs site migration', machineId: 'cloud-1' })], busy: [] }, activeId: 'local', lists, waitingCount: () => 0 });
    expect(names(rows)).toEqual(['Docs site migration']);
    expect(rows[0]).toMatchObject({ machineId: 'cloud-1', vmId: 'vm-1', sessionId: 'docs', cloudName: 'Docs site migration' });
  });

  it('on a cloud Session: lists this computer\'s Sessions as its own list would, leaving its Pane Chat to its own window', () => {
    const rows = cloudSessionRows({ cloud: { sessions: [vm({ vmId: 'vm-1', name: 'Docs site migration', machineId: 'cloud-1' })], busy: [] }, activeId: 'cloud-1', lists, waitingCount: () => 0 });
    expect(names(rows)).toEqual(['Checkout redesign']);
    expect(rows[0]).toMatchObject({ machineId: 'local', vmId: null, isPinned: true, activity: 'working', workingPanes: 2 });
  });

  it('on a cloud Session: lists this computer\'s loop Session only while a card from it waits', () => {
    const cloud = { sessions: [vm({ vmId: 'vm-1', name: 'Docs site migration', machineId: 'cloud-1' })], busy: [] };
    expect(names(cloudSessionRows({ cloud, activeId: 'cloud-1', lists, waitingCount: () => 0 }))).not.toContain('Hourly triage');
    const waiting = (machineId: string, sessionId: string) => (machineId === 'local' && sessionId === 'hourly' ? 1 : 0);
    expect(names(cloudSessionRows({ cloud, activeId: 'cloud-1', lists, waitingCount: waiting }))).toContain('Hourly triage');
  });

  it('leaves an archived cloud Session, which no computer here pairs with, to the Archived section', () => {
    const rows = cloudSessionRows({ cloud: { sessions: [vm({ vmId: 'vm-9', name: 'Old spike', machineId: null, awake: false })], busy: [] }, activeId: 'local', lists, waitingCount: () => 0 });
    expect(rows).toEqual([]);
  });

  it('shows a cloud Session not read yet as one row, stopped when its machine is', () => {
    const rows = cloudSessionRows({ cloud: { sessions: [vm({ vmId: 'vm-2', name: 'Pricing page copy', machineId: 'cloud-2', awake: false })], busy: [] }, activeId: 'local', lists, waitingCount: () => 0 });
    expect(rows).toEqual([expect.objectContaining({ name: 'Pricing page copy', sessionId: null, stopped: true })]);
  });
});
