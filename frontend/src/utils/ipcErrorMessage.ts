const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/;

/** The text without Electron's "Error invoking remote method" wrapper. */
export function stripIpcWrapper(message: string): string {
  return message.replace(IPC_WRAPPER, '');
}

/** The backend's reason from a thrown error or an `{ success: false, error }` string, without Electron's IPC wrapper. */
export function ipcErrorMessage(cause: unknown, fallback: string): string {
  return stripIpcWrapper(cause instanceof Error ? cause.message : String(cause ?? '')) || fallback;
}
