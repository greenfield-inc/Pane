import { useEffect, useState } from 'react';
import type { OrchestrationSessionOverview } from '../../../shared/types/orchestrationSession';
import { useConfigStore } from '../stores/configStore';

/** Where an orchestrator writes its Session's status page, relative to the Session folder. */
const SESSION_STATUS_PAGE = 'session/index.html';

/**
 * The file URL of the Session's status page, or null while it has none. Rechecks when
 * the Session overview changes (each refresh). A client of a remote host reads host files
 * only through a browser tab's grant, so it shows no page here.
 */
export function useSessionStatusPage(folderSessionId: string, recheck: OrchestrationSessionOverview | null): string | null {
  const remote = useConfigStore(state => state.config?.remoteDaemon?.client.mode === 'remote');
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (remote) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const request = { sessionId: folderSessionId, filePath: SESSION_STATUS_PAGE };
      const exists = await window.electronAPI.invoke('file:exists', request) === true;
      const resolved: { success: boolean; url?: string } | null = exists ? await window.electronAPI.invoke('file:getPath', request) : null;
      if (!cancelled) setUrl(resolved?.success && resolved.url ? resolved.url : null);
    })().catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [folderSessionId, recheck, remote]);
  return url;
}

/**
 * Opens a page as a browser tab in the split beside the Session's chat, or brings back the
 * tab already showing it (`runpane panels open --url`, as Open preview does).
 */
export async function openBesideChat(folderSessionId: string, url: string): Promise<void> {
  await window.electronAPI.invoke('runpane:panels:open', { paneId: folderSessionId, url, placement: 'split', source: 'user' });
}
