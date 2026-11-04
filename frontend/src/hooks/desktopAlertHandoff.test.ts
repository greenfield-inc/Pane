import { describe, expect, it, vi } from 'vitest';
import { isDesktopAlertHandedOff } from './desktopAlertHandoff';

describe('isDesktopAlertHandedOff', () => {
  it('follows the main process while Dictate is attached', async () => {
    expect(await isDesktopAlertHandedOff(vi.fn().mockResolvedValue(true))).toBe(true);
    expect(await isDesktopAlertHandedOff(vi.fn().mockResolvedValue(false))).toBe(false);
  });

  it('keeps Pane alerting when it cannot tell', async () => {
    expect(await isDesktopAlertHandedOff(undefined)).toBe(false);
    expect(await isDesktopAlertHandedOff(vi.fn().mockRejectedValue(new Error('No handler registered')))).toBe(false);
  });
});
