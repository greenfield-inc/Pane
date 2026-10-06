import { useCallback, useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from 'react';
import { Plus, Settings, ChevronDown, Type, Pencil, Trash2, ArrowUpRight } from 'lucide-react';
import { Dropdown } from '../../ui/Dropdown';
import './notesEditor.css';
import type { Note, NoteBlock, NoteContext, NoteExportResult, NoteScope } from '../../../../../shared/types/notes';
import { noteSchema, sameNoteScope } from '../../../../../shared/types/notes';

import { decodeBoundary } from '../../../../../shared/validation/boundaryDecoder';
import { useConfigStore } from '../../../stores/configStore';

const DrawingEditor = lazy(() => import('./NotesDrawing'));
const scopeLabels = { feature: 'Feature Notes', project: 'Project Notes', global: 'Global Notes', session: 'Session Notes' };
const descriptions = {
  feature: 'Notes for this worktree. Shared with agents working here.',
  project: 'Notes for this project. Shared across its worktrees and agents.',
  global: 'Notes for all your projects. Shared with your Claude, Codex, and Cursor agents.',
  session: 'Notes for this session. Choose an associated project when moving a note.',
};
const button = 'rounded px-3 py-1.5 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-interactive disabled:opacity-50';
const field = 'w-full bg-transparent text-text-primary outline-none placeholder:text-text-tertiary';

export interface NoteCapture { text: string; source: string; at: string }
interface NotesPanelProps { paneId: string; capture?: NoteCapture; viewId?: string }

export default function NotesPanel(props: NotesPanelProps) {
  const remote = useConfigStore(state => state.config?.remoteDaemon?.client.mode === 'remote');
  return remote ? <p className="p-4 text-text-secondary">Notes are available in local Pane workspaces.</p> : <LocalNotesPanel {...props} />;
}

function LocalNotesPanel({ paneId, capture, viewId = 'panel' }: NotesPanelProps) {
  const [context, setContext] = useState<NoteContext>();
  const [scope, setScope] = useState<NoteScope>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [exports, setExports] = useState<NoteExportResult[]>([]);
  const flush = useRef<(() => Promise<boolean>) | null>(null);
  const request = useRef(0);

  useEffect(() => {
    let active = true;
    const load = () => {
      void window.electronAPI.invoke('notes:context', paneId).then(ctx => {
        if (active) {
          setContext(ctx);
          setScope(previous => previous && ctx.scopes.some(item => sameNoteScope(item.scope, previous)) ? previous : ctx.defaultScope);
        }
      }).catch(cause => { if (active) setError(String(cause)); });
    };
    load();
    const unsubscribe = window.electronAPI.events.onOrchestrationSessionsChanged?.(load);
    return () => { active = false; unsubscribe?.(); };
  }, [paneId]);

  const refresh = useCallback(async () => {
    if (!scope) return;
    const generation = ++request.current;
    try {
      const list = await window.electronAPI.invoke('notes:list', paneId, scope);
      if (generation === request.current) setNotes(list);
    } catch (cause) { setError(String(cause)); }
  }, [paneId, scope]);
  useEffect(() => { void refresh(); return window.electronAPI.onNotesChanged(() => { void refresh(); }); }, [refresh]);

  const choose = async (next?: NoteScope, id?: string) => {
    if (flush.current && !await flush.current()) return;
    if (next) { ++request.current; setScope(next); setNotes([]); }
    setSelected(id);
    setError('');
  };
  const create = async () => {
    if (!scope || (flush.current && !await flush.current())) return;
    try {
      const result = await window.electronAPI.invoke('notes:mutate', paneId, { action: 'create', scope });
      setExports(result.exports);
      await refresh();
      setSelected(result.note?.id);
    } catch (cause) { setError(String(cause)); }
  };
  const current = notes.find(note => note.id === selected) ?? notes[0];
  const activeName = context?.scopes.find(item => scope && sameNoteScope(item.scope, scope))?.name;
  const scopes = context?.scopes.slice().sort((a, b) => {
    const order = { session: 0, feature: 0, project: 1, global: 2 };
    return order[a.scope.kind] - order[b.scope.kind];
  });

  return <section aria-label="Notes" className="notes-surface flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-xs">
      <div className="flex min-w-0 items-center gap-1">
        <Dropdown width="md" position="bottom-left" selectedId={current?.id}
          trigger={<button type="button" aria-label="Choose note" className="flex max-w-40 items-center gap-1.5 rounded px-1 py-1 text-text-secondary hover:text-text-primary"><span className="truncate">{current?.title || 'Notes'}</span><ChevronDown size={12} className="shrink-0" /></button>}
          items={[...notes.map(note => ({ id: note.id, label: note.title || 'Untitled', onClick: () => { void choose(undefined, note.id); } })),
            { id: 'new', label: 'New note', icon: Plus, onClick: () => { void create(); } }]}
          menuClassName="!z-modal" />
        <button type="button" aria-label="New note" title="New note" className="rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-text-primary" onClick={() => void create()} disabled={!scope}><Plus size={15} /></button>
      </div>
      <div className="ml-auto flex min-w-0 gap-0.5 overflow-x-auto" aria-label="Note scope">
        {scopes?.map(item => <button key={`${item.scope.kind}-${item.scope.id}`} type="button"
          aria-label={`${scopeLabels[item.scope.kind]}${item.scope.kind === 'project' && context?.defaultScope.kind === 'session' ? ` · ${item.name}` : ''}`}
          title={`${item.name} · ${descriptions[item.scope.kind]}`}
          aria-pressed={scope && sameNoteScope(scope, item.scope)}
          className={`whitespace-nowrap rounded px-2 py-1 transition-colors ${scope && sameNoteScope(scope, item.scope) ? 'bg-surface-hover font-medium text-text-primary' : 'text-text-tertiary hover:text-text-primary'}`}
          onClick={() => void choose(item.scope)}>{item.scope.kind === 'project' && context?.defaultScope.kind === 'session' ? item.name : scopeLabels[item.scope.kind].replace(' Notes', '')}</button>)}
      </div>
    </div>
    {error && <p role="alert" className="px-6 py-2 text-sm text-status-error">{error}</p>}
    {!current && exports.some(result => result.error) && <div role="alert" className="px-6 py-2 text-xs text-status-error">
      <p>Agent exports need attention.</p>
      {exports.filter(result => result.error).map(result => <p key={result.path} className="break-words">{result.agent}: {result.error}</p>)}
      <button type="button" className={button} onClick={() => { void window.electronAPI.invoke('notes:mutate', paneId, { action: 'retry' }).then(result => setExports(result.exports)).catch(cause => setError(String(cause))); }}>Retry exports</button>
    </div>}
    <div className="min-h-0 flex-1 overflow-auto">
      {current && context ? <NoteEditor key={current.id} paneId={paneId} note={current} context={context} flush={flush} draftKey={`pane-note-draft:${paneId}:${viewId}:${current.id}`} capture={capture}
        scopeName={activeName} viewedScope={scope} exports={exports} onExports={setExports} onRefresh={refresh} />
        : <div className="notes-document">
          <button type="button" aria-label="Start a note" onClick={() => void create()} disabled={!scope} className="block w-full py-8 text-left">
            <span className="block text-3xl font-semibold tracking-tight text-text-tertiary">Untitled</span>
            <span className="mt-5 block text-sm text-text-tertiary">{capture ? 'Start a note for this terminal excerpt…' : 'Start writing…'}</span>
          </button>
        </div>}
    </div>
  </section>;

}

function NoteEditor({ paneId, note, context, flush, capture, onExports, onRefresh, draftKey, exports, scopeName, viewedScope }: {
  paneId: string; note: Note; context: NoteContext; draftKey: string; flush: React.MutableRefObject<(() => Promise<boolean>) | null>;
  exports: NoteExportResult[]; scopeName?: string; viewedScope?: NoteScope;
  capture?: NoteCapture; onExports: (results: NoteExportResult[]) => void; onRefresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => {
    const saved = localStorage.getItem(draftKey);
    if (!saved) return note;
    try { return decodeBoundary(JSON.parse(saved), noteSchema); }
    catch { return note; }
  });
  const draftRef = useRef(draft);
  const dirty = useRef(draft !== note);
  const saving = useRef<Promise<boolean> | null>(null);
  const [status, setStatus] = useState(draft !== note ? 'Recovered draft' : 'Saved');
  const [error, setError] = useState(draft !== note ? 'Recovered an unsaved draft. Retry saving, or copy it before reloading.' : '');
  const [recoveryWarning, setRecoveryWarning] = useState('');
  const [drawing, setDrawing] = useState<Extract<NoteBlock, { type: 'drawing' }>>();
  const insertAfter = useRef<string | null | undefined>(undefined);
  const [captured, setCaptured] = useState(false);
  const [showDelivery, setShowDelivery] = useState(false);
  const change = (next: Note) => {
    draftRef.current = next; dirty.current = true; setDraft(next); setStatus('Unsaved'); setError('');
    try { localStorage.setItem(draftKey, JSON.stringify(next)); }
    catch { setRecoveryWarning('Recovery storage is full. Autosave is still active; wait for Saved before closing.'); }
  };
  useEffect(() => {
    if (!dirty.current && !saving.current) { draftRef.current = note; setDraft(note); }
  }, [note]);

  const save = useCallback(async (): Promise<boolean> => {
    while (saving.current) {
      const success = await saving.current;
      if (!success) return false;
    }
    if (!dirty.current) return true;
    const snapshot = draftRef.current;
    setStatus('Saving…');
    const pending = window.electronAPI.invoke('notes:mutate', paneId, { action: 'save', note: snapshot }).then(result => {
      if (!result.note) throw new Error('No saved note returned.');
      dirty.current = draftRef.current !== snapshot;
      draftRef.current = { ...draftRef.current, revision: result.note.revision, scope: result.note.scope };
      setDraft(draftRef.current);
      try {
        if (!dirty.current) localStorage.removeItem(draftKey);
        else localStorage.setItem(draftKey, JSON.stringify(draftRef.current));
        setRecoveryWarning('');
      } catch { setRecoveryWarning('Recovery storage is unavailable. Wait for Saved before closing.'); }
      setStatus(dirty.current ? 'Unsaved' : 'Saved');
      onExports(result.exports);
      return true;
    }).catch(cause => { setError(String(cause)); setStatus('Not saved'); return false; }).finally(() => { saving.current = null; });
    saving.current = pending;
    const success = await pending;
    return success && dirty.current ? save() : success;
  }, [paneId, onExports, draftKey]);
  useEffect(() => { flush.current = save; return () => { flush.current = null; void save(); }; }, [flush, save]);
  useEffect(() => {
    if (!dirty.current || error) return;
    const timer = setTimeout(() => { void save(); }, 600);
    return () => clearTimeout(timer);
  }, [draft, error, save]);

  const updateBlock = (block: NoteBlock) => change({ ...draftRef.current, blocks: draftRef.current.blocks.map(item => item.id === block.id ? block : item) });
  const addDrawing = (after?: string) => {
    insertAfter.current = after ?? null;
    setDrawing({ type: 'drawing', id: crypto.randomUUID(), title: 'Drawing', labels: '', scene: { elements: [], appState: {}, files: {} }, png: '' });
  };
  const mutate = async (action: 'move' | 'remove', scope?: NoteScope) => {
    if (!await save()) return;
    try {
      const result = await window.electronAPI.invoke('notes:mutate', paneId, { action, id: draftRef.current.id, revision: draftRef.current.revision, scope });
      onExports(result.exports);
      if (result.note) { draftRef.current = result.note; setDraft(result.note); }
      await onRefresh();
    } catch (cause) { setError(String(cause)); }
  };
  const projects = context.scopes.filter(item => item.scope.kind === 'project');
  const addText = (after?: string) => {
    const block: NoteBlock = { type: 'text', id: crypto.randomUUID(), text: '' };
    const blocks = draftRef.current.blocks.slice();
    blocks.splice(after ? blocks.findIndex(item => item.id === after) + 1 : 0, 0, block);
    change({ ...draftRef.current, blocks });
    requestAnimationFrame(() => document.getElementById(`note-block-${block.id}`)?.focus());
  };
  const failedExports = exports.filter(result => result.error);
  return <div className="notes-document">
    <div className="mb-4 flex min-h-7 items-center justify-end gap-2 text-xs text-text-tertiary">
      {viewedScope && !sameNoteScope(draft.scope, viewedScope) && <span className="mr-auto">Reference to {scopeLabels[draft.scope.kind]}</span>}
      <span role="status" className={error ? 'text-status-error' : ''}>{status}</span>
      <Dropdown position="bottom-right" width="lg" menuClassName="!z-modal"
        trigger={<button type="button" aria-label="Note settings" title="Note settings" className="flex items-center gap-1.5 rounded p-1.5 hover:bg-surface-hover hover:text-text-primary">
          {failedExports.length > 0 && <span className="text-status-error">Export issue</span>}<Settings size={15} />
        </button>}
        items={[
          ...((draft.scope.kind === 'feature' || draft.scope.kind === 'session') ? (projects.length > 1
            ? projects.map(item => ({ id: `project-${item.scope.id}`, label: `Move to Project Notes · ${item.name}`, icon: ArrowUpRight, onClick: () => { void mutate('move', item.scope); } }))
            : [{ id: 'project', label: 'Move to Project Notes', icon: ArrowUpRight, disabled: !projects.length, onClick: () => { if (projects[0]) void mutate('move', projects[0].scope); } }]) : []),
          ...(draft.scope.kind === 'project' ? [{ id: 'global', label: 'Move to Global Notes', icon: ArrowUpRight, onClick: () => { void mutate('move', { kind: 'global', id: 'user' }); } }] : []),
          { id: 'delete', label: 'Delete note', icon: Trash2, variant: 'danger', onClick: () => { if (window.confirm('Delete this note and all its references?')) void mutate('remove'); } },
        ]}
        footer={<div className="space-y-3 p-3 text-xs text-text-secondary">
          <p><strong className="font-medium">{scopeName || scopeLabels[draft.scope.kind]}</strong><br />{descriptions[draft.scope.kind]}</p>
          {failedExports.length > 0 && <div role="alert" className="space-y-2 text-status-error"><p>Note saved. Agent exports need attention.</p>
            {failedExports.map(result => <p key={result.path} className="break-words">{result.agent}: {result.error}</p>)}
            <button type="button" className={button} onClick={() => { void window.electronAPI.invoke('notes:mutate', paneId, { action: 'retry' }).then(result => onExports(result.exports)).catch(cause => setError(String(cause))); }}>Retry exports</button>
          </div>}
          <div><button type="button" aria-expanded={showDelivery} className="rounded text-left hover:text-text-primary focus-visible:ring-2 focus-visible:ring-interactive" onClick={() => setShowDelivery(value => !value)}>Agent delivery</button>{showDelivery && <div className="mt-2 space-y-2 leading-relaxed">
            <p>Scoped notes are read through Pane terminals. After your first scoped note, start a new agent conversation. Agents may request read permission.</p>
            <p>Global edits refresh on Codex's next turn, Claude resume, or a new Cursor conversation.</p>
            {exports.map(result => <p key={result.path} className="break-words">{result.agent}: {result.error ? 'Needs attention' : 'Updated'}<br />{result.path}</p>)}
          </div>}</div>
        </div>} />
    </div>
    {recoveryWarning && <p role="status" className="mb-3 text-xs text-status-error">{recoveryWarning}</p>}
    {error && <div role="alert" className="mb-4 text-sm text-status-error">{error}
      <p>Your unsaved draft remains here. Copy it before reloading if you want to keep it.</p>
      <button type="button" className={button} onClick={() => { localStorage.removeItem(draftKey); dirty.current = false; draftRef.current = note; setDraft(note); setError(''); setStatus('Saved'); }}>Reload saved note</button>
      <button type="button" className={button} onClick={() => { setError(''); void save(); }}>Retry save</button>
      <button type="button" className={button} onClick={() => { void navigator.clipboard.writeText(JSON.stringify(draftRef.current, null, 2)); }}>Copy draft</button>
    </div>}
    <input aria-label="Note title" placeholder="Untitled" className={`${field} notes-title mb-5 font-semibold tracking-tight`} value={draft.title} onChange={event => change({ ...draftRef.current, title: event.target.value })} />
    {capture && !captured && <button type="button" className={`${button} mb-4 text-interactive`} onClick={() => {
      change({ ...draftRef.current, blocks: [...draftRef.current.blocks, { type: 'text', id: crypto.randomUUID(), text: `Terminal excerpt · ${capture.source} · ${capture.at}\n\n${capture.text}` }] });
      setCaptured(true);
    }}>Add terminal excerpt to this note</button>}
    <div className="space-y-1">
      {draft.blocks.map((block, index) => <NoteContentBlock key={block.id} block={block} index={index}
        onChange={updateBlock} onText={() => addText(block.id)} onDrawing={() => addDrawing(block.id)}
        onRemove={() => change({ ...draftRef.current, blocks: draftRef.current.blocks.filter(item => item.id !== block.id) })}
        onEditDrawing={() => { if (block.type === 'drawing') { insertAfter.current = undefined; setDrawing(block); } }} />)}
      {draft.blocks.length === 0 && <Dropdown menuClassName="!z-modal" position="bottom-left" width="sm"
        trigger={<button type="button" aria-label="Add block" className={`${button} text-text-tertiary`}><Plus size={16} /></button>}
        items={[{ id: 'text', label: 'Text', icon: Type, onClick: () => addText() }, { id: 'drawing', label: 'Drawing', icon: Pencil, onClick: () => addDrawing() }]} />}
    </div>
    {drawing && <Suspense fallback={<p role="status">Loading drawing editor…</p>}><DrawingEditor block={drawing}
      onCancel={() => setDrawing(undefined)}
      onSave={block => {
        const blocks = draftRef.current.blocks.slice();
        if (insertAfter.current !== undefined) {
          const index = blocks.findIndex(item => item.id === insertAfter.current);
          blocks.splice(index + 1, 0, block);
        } else {
          const index = blocks.findIndex(item => item.id === block.id);
          if (index >= 0) blocks[index] = block;
        }
        change({ ...draftRef.current, blocks }); setDrawing(undefined);
      }} /></Suspense>}
  </div>;
}

function NoteContentBlock({ block, index, onChange, onText, onDrawing, onRemove, onEditDrawing }: {
  block: NoteBlock; index: number; onChange: (block: NoteBlock) => void;
  onText: () => void; onDrawing: () => void; onRemove: () => void; onEditDrawing: () => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const slash = useRef(false);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const fit = () => { element.style.height = 'auto'; element.style.height = `${element.scrollHeight}px`; };
    fit();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; fit(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [block]);
  return <div className="group relative py-1">
    <Dropdown className="absolute -left-7 top-1.5" menuClassName="!z-modal" position="bottom-left" width="sm"
      trigger={<button ref={add} type="button" aria-label={`Add block after block ${index + 1}`} title="Add block"
        className="notes-block-add rounded p-1 text-text-tertiary opacity-0 hover:bg-surface-hover hover:text-text-primary focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"><Plus size={16} /></button>}
      onOpenChange={open => { if (!open && slash.current) { slash.current = false; requestAnimationFrame(() => textarea.current?.focus()); } }}
      items={[{ id: 'text', label: 'Text', icon: Type, onClick: () => { slash.current = false; onText(); } }, { id: 'drawing', label: 'Drawing', icon: Pencil, onClick: () => { slash.current = false; onDrawing(); } },
        { id: 'remove', label: 'Delete block', icon: Trash2, variant: 'danger', onClick: onRemove }]} />
    {block.type === 'text' ? <textarea ref={textarea} id={`note-block-${block.id}`} aria-label={`Text block ${index + 1}`} rows={1}
      className={`${field} notes-text block resize-none overflow-hidden py-1 leading-relaxed`} placeholder={index === 0 ? 'Write something, or type / for blocks…' : 'Write something…'}
      value={block.text} onChange={event => onChange({ ...block, text: event.target.value })}
      onKeyDown={event => {
        const cursor = event.currentTarget.selectionStart;
        if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && (cursor === 0 || /\s/.test(block.text[cursor - 1]))) {
          event.preventDefault(); slash.current = true; add.current?.click();
        }
      }} />
      : <button type="button" aria-label={`${block.title} · Edit drawing`} className="block w-full rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-interactive" onClick={onEditDrawing}>
        {block.png && <img src={block.png} alt={block.labels || block.title} className="mx-auto max-h-96 max-w-full" />}
        <span className="mt-1 block text-xs text-text-tertiary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">{block.title} · Edit drawing</span>
      </button>}
  </div>;
}
