import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceWatchLeases } from '../services/workspaceWatchLeases';
import { isDesktopAlertHandedOff } from './desktopAlerts';

afterEach(() => vi.useRealTimers());

describe('isDesktopAlertHandedOff', () => {
  it('hands the alert off only while a `dictate` watcher is attached', () => {
    vi.useFakeTimers();
    const leases = new WorkspaceWatchLeases();
    expect(isDesktopAlertHandedOff(leases)).toBe(false);

    const other = leases.acquire('monitor');
    expect(isDesktopAlertHandedOff(leases)).toBe(false);
    other.release();

    const dictate = leases.acquire('dictate');
    expect(isDesktopAlertHandedOff(leases)).toBe(true);

    dictate.release();
    vi.advanceTimersByTime(10_000);
    expect(isDesktopAlertHandedOff(leases)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(isDesktopAlertHandedOff(leases)).toBe(false);
  });

  it('keeps alerts when no watch has been served yet', () => {
    expect(isDesktopAlertHandedOff(undefined)).toBe(false);
  });
});
