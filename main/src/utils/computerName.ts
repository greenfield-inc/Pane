import { execFileSync } from 'child_process';
import os from 'os';

/** The LocalHostName read for a host name, so it is read once per host name and a failed read is tried again. */
let cached: { host: string; name: string } | null = null;

/**
 * This computer's name as people and Tailscale know it: the host name without `.local`. A Mac that
 * took a network-assigned host name (`Mac.localdomain`, `localhost`) is named by its LocalHostName
 * instead, the name Sharing settings show and Tailscale uses.
 */
export function computerName(): string {
  const host = os.hostname().replace(/\.local$/iu, '');
  if (process.platform !== 'darwin' || (!host.includes('.') && host !== 'localhost')) return host;
  if (cached?.host === host) return cached.name;
  try {
    const name = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2_000 }).trim();
    if (!name) return host;
    cached = { host, name };
    return name;
  } catch {
    return host;
  }
}
