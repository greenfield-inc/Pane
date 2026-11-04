import { useMemo, useRef, useState } from 'react';
import { Excalidraw, exportToBlob, restore, serializeAsJSON } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { ImportedDataState } from '@excalidraw/excalidraw/data/types';
import '@excalidraw/excalidraw/index.css';
import NotesDialog from './NotesDialog';
import { Button } from '../../ui/Button';
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
  const { theme } = useTheme();
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
  return <NotesDialog label="Edit drawing">
    <div className="flex min-h-[50px] shrink-0 items-center gap-2 border-b border-border-primary px-4 py-2">
      <input aria-label="Drawing title" placeholder="Drawing" value={title} onChange={event => setTitle(event.target.value)}
        className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-[15px] font-semibold text-text-primary outline-none placeholder:text-text-tertiary hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-border-focus" />
      <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
      <Button size="sm" onClick={() => void save()} loading={saving} loadingText="Saving…">Save drawing</Button>
    </div>
    {error && <p role="alert" className="border-b border-border-primary bg-status-error/10 px-4 py-2 text-[13px] text-status-error">{error}</p>}
    <div className="min-h-0 flex-1"><Excalidraw theme={isLightTheme(theme) ? 'light' : 'dark'} initialData={initial} excalidrawAPI={value => { api.current = value; }}
      UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }} /></div>
  </NotesDialog>;
}
