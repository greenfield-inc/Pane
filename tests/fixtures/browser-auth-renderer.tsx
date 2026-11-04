import React from 'react';
import { createRoot } from 'react-dom/client';
import BrowserPanel from '../../frontend/src/components/panels/browser/BrowserPanel';
import { BrowserDataSetting } from '../../frontend/src/components/settings/categories/BrowserDataSetting';
import { useConfigStore } from '../../frontend/src/stores/configStore';
import '../../frontend/src/index.css';
import type { AppConfig } from '../../frontend/src/types/config';
import type { ToolPanel } from '../../shared/types/panels';

export interface AuthTestTab { id: string; sessionId: string; label: string; url: string }

declare global {
  interface Window { authTest: { setTabs(tabs: AuthTestTab[]): void } }
}

const toPanel = (tab: AuthTestTab): ToolPanel => ({
  id: tab.id, sessionId: tab.sessionId, type: 'browser', title: tab.label,
  state: { isActive: true, customState: { currentUrl: tab.url } },
  metadata: { createdAt: '', lastActiveAt: '', position: 0 },
});

// SAFETY: the browser panel reads only the remote client mode from the config.
useConfigStore.setState({ config: { remoteDaemon: { client: { mode: 'local' } } } as AppConfig });

function Harness() {
  const [tabs, setTabs] = React.useState<AuthTestTab[]>([]);
  React.useEffect(() => { window.authTest = { setTabs }; }, []);
  return (
    <div className="flex h-screen flex-col bg-bg-primary">
      <div className="border-b border-border-primary px-6"><BrowserDataSetting /></div>
      <div className="flex min-h-0 flex-1">
        {tabs.map(tab => (
          <div key={tab.id} data-tab={tab.id} className="flex min-w-0 flex-1 flex-col border-r border-border-primary">
            <div className="px-3 py-1 text-xs text-text-secondary">{tab.label}</div>
            <div className="min-h-0 flex-1"><BrowserPanel panel={toPanel(tab)} isActive /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
