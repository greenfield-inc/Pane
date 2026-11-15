// Linked from the page head, so the launch outline (index.html) paints with the app's own styles,
// the chat's message box included, before any of the app's code runs.
import './index.css';
import './components/agentChat/agentChat.css';
import './components/chatTab/chatTab.css';
import { loadReactScan } from './devtools/loadReactScan';

async function bootstrapDesktop(): Promise<void> {
  await loadReactScan();
  const { mountDesktopRenderer } = await import('./desktopBootstrap');
  mountDesktopRenderer();
}

bootstrapDesktop().catch(error => {
  console.error('Failed to bootstrap the Pane desktop renderer.', error);
  window.electronAPI?.diagnostics?.rendererFatal({
    kind: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    url: window.location.href
  }).catch(() => {});
});
