import { PaneError } from '../../../shared/paneError';

/** Chrome DevTools' Emulation.setEmulatedMedia parameters, for the one feature this sets. */
interface EmulatedMedia {
  features: Array<{ name: 'prefers-color-scheme'; value: ColorScheme }>;
}

/** The parts of a guest's WebContents this needs (Electron's WebContents fits); `Host` is the window's. */
export interface ColorSchemeGuest<Host> {
  getType(): string;
  hostWebContents?: Host | null;
  debugger: {
    isAttached(): boolean;
    attach(protocolVersion?: string): void;
    sendCommand(method: 'Emulation.setEmulatedMedia', params: EmulatedMedia): Promise<void>;
  };
}

export type ColorScheme = 'light' | 'dark';

/**
 * D-163: a page in a <webview> (Autopilot's documents) follows Pane's theme, not the Mac's.
 * A guest's prefers-color-scheme follows the OS whatever Pane chose, so the renderer sends Pane's
 * scheme here on load and on every theme change. Only a webview the asking window hosts.
 */
export async function setGuestColorScheme<Host>(host: Host, guest: ColorSchemeGuest<Host> | undefined | null, scheme: ColorScheme): Promise<void> {
  if (!guest || guest.getType() !== 'webview' || guest.hostWebContents !== host) {
    throw new PaneError('WEBVIEW_NOT_HOSTED', 'That page is not one this window shows, so its theme was not changed.', 'Open the document again in Autopilot.');
  }
  if (!guest.debugger.isAttached()) guest.debugger.attach('1.3');
  await guest.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
}
