import { useState } from 'react';
import { usePreviewUrl } from './usePreviewUrl';

interface FileLocation {
  sessionId: string;
  filePath: string;
}

export function FilePreviewActions({ sessionId, filePath }: FileLocation) {
  const [actionError, setActionError] = useState<string | null>(null);
  const act = async (action: 'open' | 'reveal') => {
    try {
      await window.electronAPI.invoke('file:preview-action', { sessionId, filePath }, action);
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to open file');
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <button type="button" className="px-3 py-2 rounded bg-surface-secondary text-text-primary hover:bg-surface-tertiary" onClick={() => void act('open')}>Open with system app</button>
        <button type="button" className="px-3 py-2 rounded bg-surface-secondary text-text-primary hover:bg-surface-tertiary" onClick={() => void act('reveal')}>Reveal in folder</button>
      </div>
      {actionError && <p role="alert" className="text-status-error">{actionError}</p>}
    </div>
  );
}

export function FilePreviewNotice({ sessionId, filePath, message }: FileLocation & { message: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-6 bg-surface-primary text-text-secondary">
      <p role="status">{message}</p>
      <FilePreviewActions sessionId={sessionId} filePath={filePath} />
    </div>
  );
}

export function MediaFilePreview({ sessionId, filePath, kind, fileName }: FileLocation & { kind: 'video' | 'audio'; fileName: string }) {
  const { url, error: loadError } = usePreviewUrl(sessionId, filePath);
  const [error, setError] = useState<string | null>(null);
  const [loop, setLoop] = useState(false);
  const [resolution, setResolution] = useState('');

  if (error || loadError) return <FilePreviewNotice sessionId={sessionId} filePath={filePath} message={error || loadError || 'Cannot preview this file.'} />;
  if (!url) return <div role="status" className="p-6 text-text-secondary">Loading media…</div>;
  const properties = {
    src: url, controls: true, loop, preload: 'metadata',
    onError: () => setError("Can't preview this codec or media file. Try opening it with a system app."),
    'aria-label': fileName,
  };
  return (
    <div className="h-full flex flex-col items-center justify-center gap-4 p-4 bg-surface-primary text-text-primary">
      {/* Local media has no supplied caption file. Do not fabricate empty tracks. */}
      {kind === 'video' ? (
        <video {...properties} className="w-full min-h-0 flex-1 object-contain" onLoadedMetadata={event => {
          const video = event.currentTarget;
          if (video.videoWidth) setResolution(`${video.videoWidth} × ${video.videoHeight}`);
        }} />
      ) : <audio {...properties} className="w-full max-w-xl" />}
      <div className="flex flex-wrap items-center justify-center gap-4 text-sm">
        <span className="break-all">{fileName}</span>
        {resolution && <span className="text-text-secondary">{resolution}</span>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={loop} onChange={event => setLoop(event.target.checked)} />Loop</label>
      </div>
    </div>
  );
}
