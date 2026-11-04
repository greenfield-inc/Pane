import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const POWER_SUPPLY_ROOT = '/sys/class/power_supply';

/**
 * Whether a Linux machine runs on battery, read from sysfs. Electron cannot
 * tell: its desktop-Linux power source is a stub that always reports AC.
 *
 * On battery means a system battery exists and every charger (any supply that
 * is not a battery: Mains, USB and its subtypes, Wireless, and so on) reports
 * `online` 0. Pane would rather keep a machine awake than let it sleep mid-run,
 * so anything it cannot read counts as plugged in: a desktop with no supplies,
 * a supply whose type or online state is unreadable, or no supply folder at
 * all. A peripheral's supplies (scope Device, such as a mouse battery or a
 * phone charging over USB) are ignored.
 */
export function readLinuxOnBattery(root: string = POWER_SUPPLY_ROOT): boolean {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return false;
  }

  let hasSystemBattery = false;
  for (const name of names) {
    const type = readAttribute(root, name, 'type');
    if (type === null) return false;
    if (readAttribute(root, name, 'scope') === 'Device') continue;
    if (type === 'Battery') {
      hasSystemBattery = true;
      continue;
    }
    if (readAttribute(root, name, 'online') !== '0') return false;
  }
  return hasSystemBattery;
}

function readAttribute(root: string, supply: string, attribute: string): string | null {
  try {
    return readFileSync(join(root, supply, attribute), 'utf8').trim();
  } catch {
    return null;
  }
}
