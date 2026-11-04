import React from 'react';
import { createRoot } from 'react-dom/client';
import BrowserPanel from '../../frontend/src/components/panels/browser/BrowserPanel';
import { usePanelStore } from '../../frontend/src/stores/panelStore';
import { useConfigStore } from '../../frontend/src/stores/configStore';
import type { AppConfig } from '../../frontend/src/types/config';
import '../../frontend/src/index.css';
import type { ToolPanel } from '../../shared/types/panels';

// The panel reads whether this desktop is a remote client from the app config.
async function syncClientMode(): Promise<void> {
  const { mode } = await window.electronAPI.invoke('preview-test:connection-state');
  // SAFETY: the browser panel reads only the remote client mode from the config.
  useConfigStore.setState({ config: { remoteDaemon: { client: { mode } } } as AppConfig });
}
await syncClientMode();
const initialPanel: ToolPanel = await window.electronAPI.invoke('preview-test:panel');
usePanelStore.getState().setPanels(initialPanel.sessionId, [initialPanel]);
function Preview() {
  const panel = usePanelStore(state => state.panels[initialPanel.sessionId]?.[0]);
  React.useEffect(() => {
    const update = (event: Event) => {
      // SAFETY: The isolated Electron fixture sends a ToolPanel in this event.
      usePanelStore.getState().setPanels(initialPanel.sessionId, [(event as CustomEvent<ToolPanel>).detail]);
    };
    const unsubscribe = window.electronAPI.events.onRemoteDaemonResyncRequested(({ hostChanged }) => {
      if (!hostChanged) return;
      usePanelStore.getState().removeBrowserPanelsForHostSwitch();
      // Model the production asynchronous host resync while outgoing props
      // still refer to a different file with the same panel/session IDs.
      setTimeout(async () => {
        await syncClientMode();
        const incoming: ToolPanel = await window.electronAPI.invoke('preview-test:panel');
        usePanelStore.getState().setPanels(incoming.sessionId, [incoming]);
      }, 700);
    });
    window.addEventListener('test-panel-update', update);
    return () => { unsubscribe(); window.removeEventListener('test-panel-update', update); };
  }, []);
  return <div style={{ height: '100%' }}>{panel && <BrowserPanel panel={panel} isActive />}</div>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
