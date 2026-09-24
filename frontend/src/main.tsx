// Linked from index.html's head, so the static shell paints styled before any JS runs.
import './index.css';
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
