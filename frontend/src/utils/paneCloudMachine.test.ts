import { describe, expect, it } from 'vitest';
import { groupPaneCloud, paneCloudMachine } from '../../../shared/utils/paneCloudMachine';
import type { PaneCloudSession } from '../../../shared/types/paneCloud';

const session = (fields: Partial<PaneCloudSession> & { vmId: string; name: string }): PaneCloudSession => ({
  awake: true, underReview: false, machineId: null, paneVersion: '2.4.249', createdAt: '2026-11-20T10:00:00.000Z', ...fields,
});

const sessions = [
  session({ vmId: 'vm-1', name: 'Docs site migration', machineId: 'cloud-1', createdAt: '2026-11-20T10:00:00.000Z' }),
  session({ vmId: 'vm-2', name: 'Pricing page copy', machineId: 'cloud-2', awake: false, createdAt: '2026-11-21T10:00:00.000Z' }),
  // Not paired with this computer (archived, or made on another computer): not one of its machines.
  session({ vmId: 'vm-3', name: 'Old spike', machineId: null }),
];

describe('the Pane Cloud machine', () => {
  it('is one machine with each paired cloud Session under it, newest first', () => {
    expect(paneCloudMachine(sessions)).toEqual({
      id: 'pane-cloud',
      name: 'Pane Cloud',
      members: [
        { computerId: 'cloud-2', vmId: 'vm-2', sessionName: 'Pricing page copy', awake: false },
        { computerId: 'cloud-1', vmId: 'vm-1', sessionName: 'Docs site migration', awake: true },
      ],
    });
  });

  it('is absent without a paired cloud Session', () => {
    expect(paneCloudMachine([sessions[2]])).toBeNull();
  });

  it('takes its members out of a machine list and keeps the rest in order', () => {
    const machines = [{ id: 'local' }, { id: 'cloud-1' }, { id: 'studio' }, { id: 'cloud-2' }];
    const grouped = groupPaneCloud(machines, paneCloudMachine(sessions), (machine) => machine.id);
    expect(grouped.machines).toEqual([{ id: 'local' }, { id: 'studio' }]);
    expect(grouped.members.map(({ machine, member }) => [machine.id, member.sessionName])).toEqual([['cloud-2', 'Pricing page copy'], ['cloud-1', 'Docs site migration']]);
  });
});
