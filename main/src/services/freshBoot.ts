import os from 'os';

/** Tailscale can take minutes to sign in after the computer starts: about 30 s on macOS, 2-3 min on Windows. */
const BOOT_WINDOW_MS = 5 * 60_000;
const startedAt = Date.now();

/** Pane started within five minutes of the computer starting. */
export const startedOnFreshBoot = os.uptime() * 1000 < BOOT_WINDOW_MS;

/** The first five minutes after Pane started on a fresh boot, while Tailscale may still be coming up. */
export function inBootWindow(now = Date.now()): boolean {
  return startedOnFreshBoot && now - startedAt < BOOT_WINDOW_MS;
}
