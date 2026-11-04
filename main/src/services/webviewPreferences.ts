import type { WebPreferences } from 'electron';

/**
 * Settings every <webview> guest gets, whatever the renderer asked for: no preload,
 * no Node, a sandbox, and an opaque page. Electron makes guests transparent by
 * default, so a page without its own background showed Pane's panel through it.
 */
export function hardenWebviewPreferences(webPreferences: WebPreferences): void {
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.transparent = false;
}
