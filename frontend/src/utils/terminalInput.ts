/**
 * Sends keyboard input to a terminal without waiting for delivery.
 *
 * Remote Pane rejects input it had to discard after a disconnect, a failed
 * request, or a timeout. Handle that here so it never reaches the renderer's
 * global unhandled-rejection alert, which would open a dialog per keystroke.
 */
export function sendTerminalInput(panelId: string, data: string): void {
  void window.electronAPI.invoke('terminal:input', panelId, data).catch(error => {
    console.warn('[Terminal] Input was not delivered:', error);
  });
}
