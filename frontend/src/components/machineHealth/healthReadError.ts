import { ipcErrorCode, ipcErrorMessage } from '../../utils/ipcErrorMessage';

export type HealthReadProblem =
  | { kind: 'outdated'; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'error'; message: string };

const OFFLINE_CODES = new Set(['ERR_MACHINE_OFFLINE', 'ERR_REMOTE_OFFLINE', 'ERR_MACHINE_TIMEOUT']);

/** What a failed read of another machine's health means for the page. */
export function healthReadProblem(cause: unknown): HealthReadProblem {
  const code = ipcErrorCode(cause);
  const text = ipcErrorMessage(cause, 'Pane did not say why.');
  // An older Pane has no machine health channels: its daemon answers ERR_UNKNOWN_CHANNEL.
  if (code === 'ERR_UNKNOWN_CHANNEL' || code === 'ERR_HOST_OUTDATED' || text.includes('No Pane daemon command registered')) {
    return { kind: 'outdated', message: 'Update Pane on this machine to see its health.' };
  }
  if (code && OFFLINE_CODES.has(code)) return { kind: 'offline', message: 'Offline' };
  return { kind: 'error', message: text };
}
