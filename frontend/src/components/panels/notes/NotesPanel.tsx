import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Note, NoteBlock, NoteContext, NoteExportResult, NoteScope } from '../../../../../shared/types/notes';
import { noteSchema, sameNoteScope } from '../../../../../shared/types/notes';

import { decodeBoundary } from '../../../../../shared/validation/boundaryDecoder';

const DrawingEditor = lazy(() => import('./NotesDrawing'));
const scopeLabels = { feature: 'Feature Notes', project: 'Project Notes', global: 'Global Notes', session: 'Session Notes' };
const descriptions = {
  feature: 'Notes for this worktree. Shared with agents working here.',
  project: 'Notes for this project. Shared across its worktrees and agents.',
  global: 'Notes for all your projects. Shared with your Claude, Codex, and Cursor agents.',
  session: 'Notes for this session. Choose an associated project when moving a note.',
};
const button = 'rounded px-3 py-1.5 text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-interactive disabled:opacity-50';
const field = 'w-full rounded border border-border-primary bg-bg-primary p-2 text-text-primary focus:outline-none focus:ring-2 focus:ring-interactive';

export interface NoteCapture { text: string; source: string; at: string }

export default function NotesPanel({ paneId, capture, viewId = 'panel' }: { paneId: string; capture?: NoteCapture; viewId?: string }) {
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
  const current = notes.find(note => note.id === selected);
  const activeName = context?.scopes.find(item => scope && sameNoteScope(item.scope, scope))?.name;
  const scopes = context?.scopes.slice().sort((a, b) => {
    const order = { session: 0, feature: 0, project: 1, global: 2 };
    return order[a.scope.kind] - order[b.scope.kind];
  });

  return <section aria-label="Notes" className="flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
    <div className="border-b border-border-primary p-3">
      <div className="flex flex-wrap gap-1" aria-label="Note scope">
        {scopes?.map(item => <button key={`${item.scope.kind}-${item.scope.id}`} type="button"
          aria-pressed={scope && sameNoteScope(scope, item.scope)} className={`${button} ${scope && sameNoteScope(scope, item.scope) ? 'bg-surface-hover font-semibold' : ''}`}
          onClick={() => void choose(item.scope)}>{scopeLabels[item.scope.kind]}{item.scope.kind === 'project' && context?.defaultScope.kind === 'session' ? ` · ${item.name}` : ''}</button>)}
      </div>
      {scope && <p className="mt-2 text-xs text-text-secondary"><strong>{activeName}</strong> · {descriptions[scope.kind]}</p>}
    </div>
    {error && <p role="alert" className="p-3 text-sm text-status-error">{error}</p>}
    {exports.length > 0 && <details className="border-b border-border-primary px-3 py-1 text-xs text-text-secondary"><summary>Agent export results</summary>{exports.map(result => <p key={result.path}>{result.agent}: {result.error ? 'Needs attention' : 'Updated'} · {result.path}</p>)}</details>}
    {exports.some(result => result.error) && <div role="alert" className="border-b border-border-primary p-3 text-xs text-status-error">
      Note saved, but some agent exports need attention.
      {exports.filter(result => result.error).map(result => <p key={result.path}>{result.agent}: {result.error}</p>)}
      <button type="button" className={button} onClick={() => {
        void window.electronAPI.invoke('notes:mutate', paneId, { action: 'retry' }).then(result => setExports(result.exports)).catch(cause => setError(String(cause)));
      }}>Retry exports</button>
    </div>}
    <div className="flex min-h-0 flex-1">
      <aside className="w-44 shrink-0 overflow-auto border-r border-border-primary p-2">
        <button type="button" className={`${button} flex items-center gap-1`} onClick={() => void create()} disabled={!scope}><Plus size={16} />New note</button>
        {notes.map(note => <button key={note.id} type="button" className={`${button} my-1 block w-full text-left ${selected === note.id ? 'bg-surface-hover' : ''}`}
          onClick={() => void choose(undefined, note.id)}>
          <span className="block truncate">{note.title || 'Untitled note'}</span>
          {scope && !sameNoteScope(note.scope, scope) && <span className="text-xs text-text-secondary">Reference · {scopeLabels[note.scope.kind]}</span>}
        </button>)}
      </aside>
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {current && context ? <NoteEditor key={current.id} paneId={paneId} note={current} context={context} flush={flush} draftKey={`pane-note-draft:${paneId}:${capture?.at ?? viewId}:${current.id}`} capture={capture}
          onExports={setExports} onRefresh={refresh} />
          : <p className="mt-6 text-sm text-text-secondary">{capture ? 'Choose a note or create one to save this terminal excerpt.' : 'Select a note or create one. Text and drawings stay together.'}</p>}
      </div>
    </div>
    <p className="border-t border-border-primary px-3 py-2 text-xs text-text-tertiary">Saved notes update instruction files. Running agents may need a new conversation or supported refresh to read changes.</p>
  </section>;
}

function NoteEditor({ paneId, note, context, flush, capture, onExports, onRefresh, draftKey }: {
  paneId: string; note: Note; context: NoteContext; draftKey: string; flush: React.MutableRefObject<(() => Promise<boolean>) | null>;
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
  const [drawing, setDrawing] = useState<Extract<NoteBlock, { type: 'drawing' }>>();
  const [insertAfter, setInsertAfter] = useState<string>();
  const [project, setProject] = useState('');
  const [captured, setCaptured] = useState(false);
  const change = (next: Note) => {
    draftRef.current = next; dirty.current = true; setDraft(next); setStatus('Unsaved'); setError('');
    try { localStorage.setItem(draftKey, JSON.stringify(next)); }
    catch { setError('Cannot keep a recovery copy of this draft. Retry saving before closing the note.'); }
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
      if (!dirty.current) localStorage.removeItem(draftKey);
      else localStorage.setItem(draftKey, JSON.stringify(draftRef.current));
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
  const addDrawing = (after: string) => {
    setInsertAfter(after);
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
  return <div className="mx-auto max-w-3xl space-y-4">
    <div className="flex flex-wrap items-center gap-2 text-xs text-text-secondary">
      <strong>{scopeLabels[draft.scope.kind]}</strong><span role="status">{status}</span>
      <button type="button" className={`${button} ml-auto`} aria-label="Delete note" onClick={() => {
        if (window.confirm('Delete this note and all its references?')) void mutate('remove');
      }}><Trash2 size={15} /></button>
    </div>
    {draft.scope.kind === 'global' && <p className="text-sm text-text-secondary">Editing this note updates global memory for all your projects.</p>}
    {error && <div role="alert" className="text-sm text-status-error">{error}
      <p>Your unsaved draft remains here. Copy it before reloading if you want to keep it.</p>
      <button type="button" className={button} onClick={() => { localStorage.removeItem(draftKey); dirty.current = false; draftRef.current = note; setDraft(note); setError(''); setStatus('Saved'); }}>Reload saved note</button>
      <button type="button" className={button} onClick={() => { setError(''); void save(); }}>Retry save</button>
      <button type="button" className={button} onClick={() => { void navigator.clipboard.writeText(JSON.stringify(draftRef.current, null, 2)); }}>Copy draft</button>
    </div>}
    <input aria-label="Note title" className={`${field} text-lg font-semibold`} value={draft.title} onChange={event => change({ ...draftRef.current, title: event.target.value })} />
    {capture && !captured && <button type="button" className={`${button} bg-surface-hover`} onClick={() => {
      change({ ...draftRef.current, blocks: [...draftRef.current.blocks, { type: 'text', id: crypto.randomUUID(), text: `Terminal excerpt · ${capture.source} · ${capture.at}\n\n${capture.text}` }] });
      setCaptured(true);
    }}>Add terminal excerpt to this note</button>}
    {draft.blocks.map((block, index) => <div key={block.id} className="space-y-2">
      {block.type === 'text' ? <>
        <textarea aria-label={`Text block ${index + 1}`} className={`${field} min-h-28 resize-y`} placeholder="Write a note… Type / for a drawing."
          value={block.text} onChange={event => updateBlock({ ...block, text: event.target.value })} />
        {/\/(drawing)?\s*$/.test(block.text) && <button type="button" className={`${button} bg-surface-hover`} onClick={() => addDrawing(block.id)}>/drawing · Insert drawing</button>}
      </> : <button type="button" className="block w-full rounded border border-border-primary p-3 text-left" onClick={() => { setInsertAfter(undefined); setDrawing(block); }}>
        <span className="text-sm font-medium">{block.title} · Edit drawing</span>
        {block.png && <img src={block.png} alt={block.labels || block.title} className="mx-auto max-h-80 max-w-full" />}
      </button>}
      <div className="flex gap-2 text-xs text-text-tertiary">
        <button type="button" className={button} onClick={() => {
          const blocks = draftRef.current.blocks.slice(); blocks.splice(index + 1, 0, { type: 'text', id: crypto.randomUUID(), text: '' });
          change({ ...draftRef.current, blocks });
        }}>Add text below</button>
        <button type="button" className={button} onClick={() => change({ ...draftRef.current, blocks: draftRef.current.blocks.filter(item => item.id !== block.id) })}>Remove block</button>
      </div>
    </div>)}
    {draft.blocks.length === 0 && <button type="button" className={button} onClick={() => change({ ...draftRef.current, blocks: [{ type: 'text', id: crypto.randomUUID(), text: '' }] })}>Add text</button>}
    <div className="flex flex-wrap items-center gap-2 border-t border-border-primary pt-4">
      {(draft.scope.kind === 'feature' || draft.scope.kind === 'session') && <>
        {projects.length > 1 && <select aria-label="Destination project" className={`${field} max-w-60`} value={project} onChange={event => setProject(event.target.value)}>
          <option value="">Choose a project…</option>{projects.map(item => <option key={item.scope.id} value={item.scope.id}>{item.name}</option>)}
        </select>}
        <button type="button" className={button} disabled={!projects.length || (projects.length > 1 && !project)} onClick={() => void mutate('move', { kind: 'project', id: projects.length === 1 ? projects[0].scope.id : project })}>Move to Project Notes</button>
      </>}
      {draft.scope.kind === 'project' && <button type="button" className={button} onClick={() => void mutate('move', { kind: 'global', id: 'user' })}>Move to Global Notes</button>}
    </div>
    {drawing && <Suspense fallback={<p role="status">Loading drawing editor…</p>}><DrawingEditor block={drawing}
      onCancel={() => setDrawing(undefined)}
      onSave={block => {
        const blocks = draftRef.current.blocks.slice();
        if (insertAfter) {
          const index = blocks.findIndex(item => item.id === insertAfter);
          const previous = blocks[index];
          if (previous?.type === 'text') blocks[index] = { ...previous, text: previous.text.replace(/\/(drawing)?\s*$/, '') };
          blocks.splice(index + 1, 0, block);
        } else {
          const index = blocks.findIndex(item => item.id === block.id);
          if (index >= 0) blocks[index] = block;
        }
        change({ ...draftRef.current, blocks }); setDrawing(undefined);
      }} /></Suspense>}
  </div>;
}
