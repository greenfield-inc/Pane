import { useEffect, useState } from 'react';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { SessionProgress } from '../../../shared/types/orchestrationSession';

const progressResponse = boundary.union(
  boundary.object({ success: boundary.literal(true), data: boundary.union(
    boundary.object({ state: boundary.enumeration('disabled', 'empty') }),
    boundary.object({ state: boundary.literal('ready'), html: boundary.string, revision: boundary.string }),
  ) }),
  boundary.object({ success: boundary.literal(false), error: boundary.string }),
);

export function useSessionProgress(sessionId: string, enabled: boolean) {
  const [document, setDocument] = useState<Extract<SessionProgress, { state: 'ready' }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hadDocument = false;
    setDocument(null);
    setError(null);
    if (!enabled) return;
    const refresh = async () => {
      if (disposed || pending || window.document.hidden) return;
      pending = true;
      clearTimeout(timer);
      try {
        const result = decodeBoundary(await window.electronAPI.invoke('orchestration-sessions:progress', { sessionId }), progressResponse);
        if (disposed) return;
        if (!result.success) throw new Error(result.error);
        if (result.data.state === 'ready') {
          const next = result.data;
          hadDocument = true;
          setDocument(current => current?.revision === next.revision ? current : next);
          setError(null);
        } else if (result.data.state === 'disabled') {
          setDocument(null);
          setError(null);
        } else {
          setError(hadDocument ? 'Waiting for progress.html. Showing the last available page.' : null);
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : 'Could not read progress');
      } finally {
        pending = false;
        if (!disposed && !window.document.hidden) timer = setTimeout(() => { void refresh(); }, 1000);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!window.document.hidden) void refresh();
    };
    window.document.addEventListener('visibilitychange', visibility);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      window.document.removeEventListener('visibilitychange', visibility);
    };
  }, [sessionId, enabled]);
  return { document: enabled ? document : null, error: enabled ? error : null };
}
