import { execFileSync } from 'child_process';
import os from 'os';

let cached: string | null = null;

/**
 * This computer's name as people and Tailscale know it: the host name without `.local`. A Mac that
 * took a network-assigned host name (`Mac.localdomain`, `localhost`) is named by its LocalHostName
 * instead, the name Sharing settings show and Tailscale uses.
 */
export function computerName(): string {
  cached ??= readComputerName();
  return cached;
}

function readComputerName(): string {
  const host = os.hostname().replace(/\.local$/iu, '');
  if (process.platform !== 'darwin' || (!host.includes('.') && host !== 'localhost')) return host;
  try {
    return execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', timeout: 2_000 }).trim() || host;
  } catch {
    return host;
  }
}
