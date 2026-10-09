import { lazy, Suspense, useEffect, useState } from 'react';
import type { FilePreviewKind } from '../../../../../shared/utils/filePreview';
import type { FilePreviewListing } from '../../../../../shared/types/filePreview';
import { MarkdownPreview } from '../../MarkdownPreview';
import { MonacoErrorBoundary } from '../../MonacoErrorBoundary';
import { isLightTheme, useTheme } from '../../../contexts/ThemeContext';
import { FilePreviewActions, FilePreviewNotice } from './MediaFilePreview';
import { usePreviewUrl } from './usePreviewUrl';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { fileExtension, getLanguageFromPath } from './fileKinds';
import { parseDelimitedPreview, readPreviewText } from './documentPreviewData';

const Editor = lazy(() => import('@monaco-editor/react'));

interface PreviewProps {
  sessionId: string;
  filePath: string;
  fileName: string;
  kind: Exclude<FilePreviewKind, 'audio' | 'video'>;
}

function PreviewTable({ columns, rows }: Pick<FilePreviewListing, 'columns' | 'rows'>) {
  // This immutable read-only snapshot has no sorting, filtering, or cell state.
  // Positions identify cells; duplicate headers and rows are valid data.
  return (
    <div className="h-full overflow-auto">
      <table className="min-w-full text-sm border-collapse text-text-primary">
        <thead className="sticky top-0 bg-surface-secondary"><tr>{columns.map((column, index) => <th key={index} className="border border-border-primary px-3 py-2 text-left font-medium">{column || `Column ${index + 1}`}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} className="border border-border-primary px-3 py-2 whitespace-pre-wrap max-w-lg break-words">{cell}</td>)}</tr>)}</tbody>
      </table>
      {!rows.length && <p className="p-4 text-text-secondary">No rows to display.</p>}
    </div>
  );
}

function FontSpecimen({ url, sessionId, filePath }: { url: string; sessionId: string; filePath: string }) {
  const [family, setFamily] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [sample, setSample] = useState('The quick brown fox jumps over the lazy dog.');
  useEffect(() => {
    let disposed = false;
    const face = new FontFace(`pane-preview-${crypto.randomUUID()}`, `url("${url}")`);
    void face.load().then(loaded => {
      if (!disposed) { document.fonts.add(loaded); setFamily(loaded.family); }
    }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; document.fonts.delete(face); };
  }, [url]);
  if (error) return <FilePreviewNotice sessionId={sessionId} filePath={filePath} message="Cannot preview this font." />;
  return (
    <div className="h-full overflow-auto p-6 space-y-6 text-text-primary">
      <label className="block text-sm">Specimen text<input className="mt-2 w-full rounded border border-border-primary bg-surface-secondary p-2" value={sample} onChange={event => setSample(event.target.value)} /></label>
      {!family ? <p role="status">Loading font…</p> : <div style={{ fontFamily: family }} className="space-y-6 break-words">
        {[16, 24, 36, 48, 72].map(size => <p key={size} style={{ fontSize: size }}>{sample}</p>)}
        <p className="text-2xl">ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz<br />0123456789 !@#$%&amp;*()[]</p>
      </div>}
    </div>
  );
}

export function DocumentFilePreview({ sessionId, filePath, fileName, kind }: PreviewProps) {
  const { url, error: urlError } = usePreviewUrl(sessionId, filePath);
  const { theme } = useTheme();
  const [source, setSource] = useState(false);
  const [document, setDocument] = useState<{ text: string; truncated: boolean } | null>(null);
  const [listing, setListing] = useState<FilePreviewListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isText = ['markdown', 'html', 'table', 'structured'].includes(kind);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        if (isText) {
          const result = await readPreviewText(url, controller.signal);
          if (!controller.signal.aborted) setDocument(result);
        } else if (kind === 'archive' || kind === 'sqlite') {
          const result: FilePreviewListing = await window.electronAPI.invoke('file:preview-list', { sessionId, filePath });
          if (!controller.signal.aborted) setListing(result);
        }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? ipcErrorMessage(reason, 'Cannot preview this file.') : 'Cannot preview this file.');
      }
    };
    void load();
    return () => controller.abort();
  }, [url, isText, kind, sessionId, filePath]);

  const notice = (message: string) => <FilePreviewNotice sessionId={sessionId} filePath={filePath} message={message} />;
  if (urlError || error) return notice(urlError || error || 'Cannot preview this file.');
  if (!url || (isText && !document) || ((kind === 'archive' || kind === 'sqlite') && !listing)) return <p role="status" className="p-6 text-text-secondary">Loading preview…</p>;

  let content = document?.text ?? '';
  let table: ReturnType<typeof parseDelimitedPreview> | null = null;
  let formatError: string | null = null;
  if (!source && document) {
    try {
      const ext = fileExtension(filePath);
      if (kind === 'table') table = parseDelimitedPreview(content, ext === 'tsv' ? '\t' : ',', document.truncated);
      else if (ext === 'json' && !document.truncated) content = JSON.stringify(JSON.parse(content), null, 2);
      else if ((ext === 'jsonl' || ext === 'ndjson') && !document.truncated) content = content.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.stringify(JSON.parse(line), null, 2)).join('\n\n');
    } catch {
      formatError = 'Cannot format this file. Use Source to inspect it read-only.';
    }
  }
  return (
    <div className="h-full flex flex-col bg-surface-primary">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-border-primary text-xs text-text-secondary">
        <span>{kind === 'html' ? 'Read-only HTML source' : 'Read-only preview'}</span>
        {kind === 'pdf' && <FilePreviewActions sessionId={sessionId} filePath={filePath} />}
        {isText && kind !== 'html' && <div className="flex gap-2">
          <button type="button" aria-pressed={!source} onClick={() => setSource(false)} className="px-2 py-1 rounded bg-surface-secondary text-text-primary">Preview</button>
          <button type="button" aria-pressed={source} onClick={() => setSource(true)} className="px-2 py-1 rounded bg-surface-secondary text-text-primary">Source</button>
        </div>}
        {document?.truncated && <span role="status">Showing the first 1 MiB.</span>}
        {table?.truncated && <span>Table preview limited to 500 data rows.</span>}
        {listing && <span>{listing.notice}</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {formatError ? notice(formatError) : kind === 'image' ? (
          <div className="h-full flex items-center justify-center p-4 overflow-auto"><img src={url} alt={fileName} className="max-w-full max-h-full object-contain" onError={() => setError('Cannot preview this image.')} /></div>
        ) : kind === 'pdf' ? (
          <object data={url} onError={() => setError('Cannot preview this PDF.')} type="application/pdf" aria-label={fileName} className="w-full h-full">{notice('Cannot preview this PDF.')}</object>
        ) : kind === 'font' ? <FontSpecimen url={url} sessionId={sessionId} filePath={filePath} />
        : listing ? <PreviewTable columns={listing.columns} rows={listing.rows} />
        : table ? <PreviewTable columns={table.rows[0] ?? []} rows={table.rows.slice(1)} />
        : !source && kind === 'markdown' ? <div className="h-full overflow-auto p-6"><MarkdownPreview content={content} /></div>
        : (
          <MonacoErrorBoundary><Suspense fallback={<p role="status" className="p-6 text-text-secondary">Loading source editor...</p>}><Editor theme={isLightTheme(theme) ? 'light' : 'vs-dark'} value={content} language={getLanguageFromPath(filePath)} options={{ readOnly: true, domReadOnly: true, folding: true, minimap: { enabled: false }, wordWrap: 'on', automaticLayout: true }} /></Suspense></MonacoErrorBoundary>
        )}
      </div>
    </div>
  );
}
