import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Excalidraw, exportToBlob, restore, serializeAsJSON } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ImportedDataState } from '@excalidraw/excalidraw/data/types';
import '@excalidraw/excalidraw/index.css';
import type { NoteBlock } from '../../../../../shared/types/notes';
import { boundary, decodeBoundary } from '../../../../../shared/validation/boundaryDecoder';
import { isLightTheme, useTheme } from '../../../contexts/ThemeContext';

declare global { interface Window { EXCALIDRAW_ASSET_PATH?: string } }

window.EXCALIDRAW_ASSET_PATH = new URL('./excalidraw-assets/', window.location.href).href;

type Drawing = Extract<NoteBlock, { type: 'drawing' }>;

export default function NotesDrawing({ block, onSave, onCancel }: {
  block: Drawing; onSave: (block: Drawing) => void; onCancel: () => void;
}) {
  const [title, setTitle] = useState(block.title);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const { theme } = useTheme();
  useEffect(() => { dialog.current?.showModal(); }, []);
  // SAFETY: restore is Excalidraw's own import validator/normalizer for saved JSON.
  const initial = useMemo(() => restore(block.scene as ImportedDataState, null, null), [block.scene]);
  const save = async () => {
    if (!api.current) return;
    setSaving(true);
    try {
      const elements = api.current.getSceneElements();
      const appState = api.current.getAppState();
      const files = api.current.getFiles();
      const scene = decodeBoundary(JSON.parse(serializeAsJSON(elements, appState, files, 'local')), boundary.jsonObject);
      const blob = await exportToBlob({ elements, appState: { ...appState, exportBackground: true }, files, mimeType: 'image/png' });
      const png = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          try { resolve(decodeBoundary(reader.result, boundary.string)); }
          catch (cause) { reject(cause); }
        };
        reader.onerror = () => reject(new Error('Could not render drawing.'));
        reader.readAsDataURL(blob);
      });
      onSave({ ...block, title, scene, png, labels: elements.flatMap(element => element.type === 'text' ? [element.text] : []).join(' · ') });
    } catch (cause) { setError(String(cause)); }
    finally { setSaving(false); }
  };
  // Excalidraw uses Escape for its own menus/tools without always preventing the
  // native cancel event. Prevent the key default too: repeated native cancel
  // requests can force-close a dialog despite preventDefault on its cancel event.
  return createPortal(<dialog ref={dialog} aria-label="Edit drawing" onKeyDownCapture={event => { if (event.key === 'Escape') event.preventDefault(); }} onCancel={event => event.preventDefault()} className="fixed inset-4 m-0 h-auto w-auto max-h-none max-w-none flex-col rounded-lg border border-border-primary bg-bg-primary p-0 text-text-primary shadow-xl open:flex">
    <div className="flex items-center gap-3 border-b border-border-primary p-3">
      <input aria-label="Drawing title" value={title} onChange={event => setTitle(event.target.value)} className="min-w-0 flex-1 rounded bg-bg-secondary p-2" />
      <button type="button" onClick={onCancel} disabled={saving}>Cancel</button>
      <button type="button" className="rounded bg-interactive px-3 py-2 text-text-on-interactive" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save drawing'}</button>
    </div>
    {error && <p role="alert" className="p-2 text-status-error">{error}</p>}
    <div className="min-h-0 flex-1"><Excalidraw theme={isLightTheme(theme) ? 'light' : 'dark'} initialData={initial} excalidrawAPI={value => { api.current = value; }}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }} /></div>
  </dialog>, document.body);
}
