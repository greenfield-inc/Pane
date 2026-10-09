import { useEffect, useState } from 'react';

/** The caller keys its preview by file/reopen identity. */
export function usePreviewUrl(sessionId: string, filePath: string) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let source: string | null = null;
    const release = (value: string) => {
      void window.electronAPI.invoke('file:release-preview', value).catch(() => {});
    };
    const acquire = async () => {
      try {
        const value: string = await window.electronAPI.invoke('file:preview-url', { sessionId, filePath });
        if (disposed) release(value);
        else { source = value; setUrl(value); }
      } catch {
        if (!disposed) setError('Cannot preview this file. It may have been moved or deleted.');
      }
    };
    void acquire();
    return () => { disposed = true; if (source) release(source); };
  }, [sessionId, filePath]);
  return { url, error };
}
