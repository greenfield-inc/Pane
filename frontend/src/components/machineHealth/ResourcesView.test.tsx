import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MachineHealthData } from './useMachineHealth';
import { DiskSection } from './ResourcesView';

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
});

const GB = 1024 ** 3;
function data(): MachineHealthData {
  return {
    snapshot: {
      sampledAt: 0, platform: 'linux', hostname: 'example-host', cpuPercent: 0,
      app: { rssMB: 100, cpuPercent: 0 }, panes: [], leaks: [],
      memory: { level: 'ok', source: 'available', detail: '', totalBytes: 32 * GB, freeBytes: 8 * GB, swapUsedBytes: null },
      disk: { level: 'warning', volumes: [
        { path: '/srv/pane-data', roles: ['pane-data', 'worktrees'], totalBytes: 1600 * GB, freeBytes: 800 * GB, level: 'ok' },
        { path: '/tmp', roles: ['temp'], totalBytes: 32 * GB, freeBytes: 12 * GB, level: 'warning' },
      ] },
    },
    inventory: null, finished: [], history: [], pending: false, readAt: 0,
    relief: { idle: { paneIds: [], memoryMB: 0 }, leftBehind: [] },
  };
}

describe('Resources disk display', () => {
  it.each([false, true])('keeps primary figures healthy and names the separate temp warning (reversed=%s)', reversed => {
    const health = data();
    if (reversed) health.snapshot.disk.volumes.reverse();
    const markup = renderToStaticMarkup(<DiskSection data={health} />);
    const disk = markup.match(/<section[^>]*aria-label="Disk"[\s\S]*?<\/section>/u)?.[0] ?? '';
    expect(disk).toContain('/srv/pane-data');
    expect(disk).toMatch(/class="[^"]*bg-surface-secondary[^"]*">800 GB free/u);
    expect(disk).toContain('/tmp');
    expect(disk).toMatch(/class="[^"]*text-status-warning[^"]*"[\s\S]*12 GB free of 32 GB/u);
  });

  it('keeps a single critical volume critical without a duplicate volume row', () => {
    const health = data();
    health.snapshot.disk.volumes = [{ path: '/', roles: ['pane-data', 'temp'], totalBytes: 500 * GB, freeBytes: 3 * GB, level: 'critical' }];
    health.snapshot.disk.level = 'critical';
    const markup = renderToStaticMarkup(<DiskSection data={health} />);
    const disk = markup.match(/<section[^>]*aria-label="Disk"[\s\S]*?<\/section>/u)?.[0] ?? '';
    expect(disk).toContain('497 GB of 500 GB used');
    expect(disk).toMatch(/class="[^"]*text-status-error[^"]*"[\s\S]*3.0 GB free/u);
    expect(disk).not.toContain('free of');
  });
});
