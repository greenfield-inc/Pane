import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

export type ClearBrowserDataOutcome = { kind: 'success' | 'failure'; message: string };

/** Asks this computer's main process to sign out of every site in Pane's browser. */
export async function clearBrowserData(
  invoke: (channel: string) => Promise<void> = channel => window.electronAPI.invoke(channel),
): Promise<ClearBrowserDataOutcome> {
  try {
    await invoke('browser-data:clear');
    return { kind: 'success', message: "Browser data cleared. You're signed out of every site in Pane's browser." };
  } catch (error) {
    return { kind: 'failure', message: ipcErrorMessage(error, "Pane couldn't clear its browser data. Try Clear browser data again.") };
  }
}
