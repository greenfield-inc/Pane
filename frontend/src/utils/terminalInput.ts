import { terminalTiming } from './terminalTiming';

/**
 * Sends keyboard input to a terminal without waiting for delivery.
 *
 * Remote Pane rejects input it had to discard after a disconnect, a failed
 * request, or a timeout. Handle that here so it never reaches the renderer's
 * global unhandled-rejection alert, which would open a dialog per keystroke.
 */
export function sendTerminalInput(panelId: string, data: string): void {
  const started = terminalTiming ? performance.now() : 0;
  const delivery = window.electronAPI.invoke('terminal:input', panelId, data);
  if (terminalTiming) {
    void delivery.then(() => terminalTiming?.record('inputRoundTrip', performance.now() - started), () => {});
  }
  void delivery.catch(error => {
    console.warn('[Terminal] Input was not delivered:', error);
  });
}
