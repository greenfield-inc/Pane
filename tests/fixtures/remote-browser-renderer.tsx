import React from 'react';
import { createRoot } from 'react-dom/client';
import BrowserPanel from '../../frontend/src/components/panels/browser/BrowserPanel';
import '../../frontend/src/index.css';
import type { ToolPanel } from '../../shared/types/panels';

const initialPanel: ToolPanel = await window.electronAPI.invoke('preview-test:panel');
function Preview() {
  const [panel, setPanel] = React.useState(initialPanel);
  React.useEffect(() => {
    const update = (event: Event) => {
      // SAFETY: The isolated Electron fixture sends a ToolPanel in this event.
      setPanel((event as CustomEvent<ToolPanel>).detail);
    };
    window.addEventListener('test-panel-update', update);
    return () => window.removeEventListener('test-panel-update', update);
  }, []);
  return <BrowserPanel panel={panel} isActive />;
}
createRoot(document.getElementById('root')!).render(<Preview />);
