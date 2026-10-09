/** The backend's reason without Electron's "Error invoking remote method" wrapper. */
export function ipcErrorMessage(error: Error, fallback: string): string {
  return error.message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') || fallback;
}
