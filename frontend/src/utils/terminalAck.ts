/** Acknowledge rendered output to the host that owns the terminal. */
export function acknowledgeTerminalOutput(
  panelId: string,
  bytes: number,
  ptyId: string | null,
  isRemoteMode: boolean,
  viewerId?: string,
): void {
  if (!isRemoteMode && ptyId) {
    window.electronAPI.ptyHost.ack(ptyId, bytes);
  } else {
    void window.electronAPI.invoke('terminal:ack', panelId, bytes, ...(viewerId === undefined ? [] : [viewerId])).catch((error) => {
      console.warn('[Terminal] Output acknowledgement was not delivered:', error);
    });
  }
}
