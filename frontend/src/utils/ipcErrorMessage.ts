import { PaneError } from '../../../shared/paneError';
import { RemoteRequestError } from '../../../shared/remoteClient/remoteDaemonClient';

/** Electron's wrapper, then the error's own `Error:` or, for a PaneError, `Error [CODE]:` (see rejectWithPaneErrorText). */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:Error(?: \[([^\]\s]+)\])?:\s*)?/;

/** The text without Electron's "Error invoking remote method" wrapper. */
export function stripIpcWrapper(message: string): string {
  return message.replace(IPC_WRAPPER, '');
}

/** The backend's reason from a thrown error or an `{ success: false, error }` string, without Electron's IPC wrapper. */
export function ipcErrorMessage(cause: unknown, fallback: string): string {
  return stripIpcWrapper(cause instanceof Error ? cause.message : String(cause ?? '')) || fallback;
}

/** A PaneError's code: carried by a remote client's error, or in the text Electron IPC hands back. */
export function ipcErrorCode(cause: unknown): string | undefined {
  if (cause instanceof PaneError) return cause.code;
  if (cause instanceof RemoteRequestError) return cause.code ?? undefined;
  return cause instanceof Error ? IPC_WRAPPER.exec(cause.message)?.[1] : undefined;
}
