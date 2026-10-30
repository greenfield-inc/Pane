import { useCallback, useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Settings, ChevronDown, Type, Pencil, Trash2, ArrowUpRight, NotebookPen, TerminalSquare } from 'lucide-react';
import { Dropdown } from '../../ui/Dropdown';
import { Button, IconButton } from '../../ui/Button';
import { cn } from '../../../utils/cn';
import './notesEditor.css';
import type { Note, NoteBlock, NoteContext, NoteExportResult, NoteScope } from '../../../../../shared/types/notes';
import { noteSchema, sameNoteScope } from '../../../../../shared/types/notes';

import { decodeBoundary } from '../../../../../shared/validation/boundaryDecoder';
import { useConfigStore } from '../../../stores/configStore';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';

const DrawingEditor = lazy(() => import('./NotesDrawing'));
const scopeLabels = { feature: 'Feature Notes', project: 'Project Notes', global: 'Global Notes', session: 'Session Notes' };
const descriptions = {
  feature: 'Notes for this worktree.',
  project: 'Notes for this project.',
  global: 'Notes for all your projects.',
  session: 'Notes for this session.',
};
const field = 'w-full bg-transparent text-text-primary outline-none placeholder:text-text-tertiary';
const alert = 'space-y-2 rounded-[10px] bg-status-error/10 px-3.5 py-3 text-[13px] text-status-error';

export interface NoteCapture { text: string; source: string; at: string }
interface NotesPanelProps { paneId: string; capture?: NoteCapture; viewId?: string }

/** The desktop's refusal for a command the connected machine's Pane does not have yet. */
const OLDER_HOST = 'runs an older Pane';

/** Notes live on the machine the desktop is on, so a connected machine answers with its own notes. */
export default function NotesPanel({ paneId, capture, viewId = 'panel' }: NotesPanelProps) {
  const machine = useConfigStore(state => {
    const client = state.config?.remoteDaemon?.client;
    return client?.mode === 'remote' ? client.profiles.find(profile => profile.id === client.activeProfileId)?.label : undefined;
  });
  const [olderHost, setOlderHost] = useState(false);
  const [context, setContext] = useState<NoteContext>();
  const [scope, setScope] = useState<NoteScope>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [exports, setExports] = useState<NoteExportResult[]>([]);
  const flush = useRef<(() => Promise<boolean>) | null>(null);
  const request = useRef(0);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      void window.electronAPI.invoke('notes:context', paneId).then(ctx => {
        if (active) {
          setOlderHost(false);
          setContext(ctx);
          setScope(previous => previous && ctx.scopes.some(item => sameNoteScope(item.scope, previous)) ? previous : ctx.defaultScope);
        }
      }).catch(cause => {
        if (!active) return;
        const message = ipcErrorMessage(cause, 'Pane did not say why.');
        if (message.includes(OLDER_HOST)) setOlderHost(true);
        else setError(message);
      });
    };
    load();
    const unsubscribe = window.electronAPI.events.onOrchestrationSessionsChanged?.(load);
    // A reconnect keeps this tab open; the host may have been updated meanwhile, so ask again.
    const unsubscribeResync = window.electronAPI.events.onRemoteDaemonResyncRequested(load);
    return () => { active = false; unsubscribe?.(); unsubscribeResync(); };
  }, [paneId]);

  const refresh = useCallback(async () => {
    if (!scope) return;
    const generation = ++request.current;
    try {
      const list = await window.electronAPI.invoke('notes:list', paneId, scope);
      if (generation === request.current) setNotes(list);
    } catch (cause) { setError(ipcErrorMessage(cause, 'Pane did not say why.')); }
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
    } catch (cause) { setError(ipcErrorMessage(cause, 'Pane did not say why.')); }
  };
  const current = notes.find(note => note.id === selected) ?? notes[0];
  const scopes = context?.scopes.slice().sort((a, b) => {
    const order = { session: 0, feature: 0, project: 1, global: 2 };
    return order[a.scope.kind] - order[b.scope.kind];
  });

  const retryExports = () => { void window.electronAPI.invoke('notes:mutate', paneId, { action: 'retry' }).then(result => setExports(result.exports)).catch(cause => setError(ipcErrorMessage(cause, 'Pane did not say why.'))); };

  if (olderHost) return <p className="p-5 text-[13px] text-text-tertiary">Update Pane on {machine ?? 'that machine'} to use its notes.</p>;

  return <section aria-label="Notes" className="notes-surface flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
    <header className="flex min-h-[50px] shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border-primary px-4 py-2">
      <Dropdown className="min-w-0" width="md" position="bottom-left" selectedId={current?.id} selectedMark="check"
        trigger={<button type="button" aria-label="Choose note" className="flex min-w-0 max-w-56 items-center gap-1 rounded-md px-1.5 py-1 text-[15px] font-semibold text-text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"><span className="truncate">{current ? current.title || 'Untitled' : 'Notes'}</span><ChevronDown size={14} className="shrink-0 text-text-tertiary" /></button>}
        items={[...notes.map(note => ({ id: note.id, label: note.title || 'Untitled', onClick: () => { void choose(undefined, note.id); } })),
          { id: 'new', label: 'New note', icon: Plus, onClick: () => { void create(); } }]}
        menuClassName="!z-modal" />
      <div role="group" aria-label="Note scope" className="flex min-w-0 gap-0.5 overflow-x-auto rounded-[9px] bg-surface-tertiary p-[3px] text-[12.5px] font-medium">
        {scopes?.map(item => {
          const active = scope && sameNoteScope(scope, item.scope);
          const named = item.scope.kind === 'project' && context?.defaultScope.kind === 'session';
          return <button key={`${item.scope.kind}-${item.scope.id}`} type="button"
            aria-label={`${scopeLabels[item.scope.kind]}${named ? ` · ${item.name}` : ''}`}
            title={`${item.name} · ${descriptions[item.scope.kind]}`}
            aria-pressed={active}
            className={cn('whitespace-nowrap rounded-md px-2.5 py-[3px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus', active ? 'bg-surface-primary text-text-primary shadow-sm' : 'text-text-tertiary hover:text-text-primary')}
            onClick={() => void choose(item.scope)}>{named ? item.name : scopeLabels[item.scope.kind].replace(' Notes', '')}</button>;
        })}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <div ref={setToolbar} className="flex items-center gap-1" />
        <IconButton aria-label="New note" title="New note" icon={<Plus size={16} />} disabled={!scope} onClick={() => void create()} />
      </div>
    </header>
    {(error || (!current && exports.some(result => result.error))) && <div className="shrink-0 space-y-2 px-4 pt-3">
      {error && <p role="alert" className={alert}>{error}</p>}
      {!current && exports.some(result => result.error) && <div role="alert" className={alert}>
        <p className="font-medium">Agent exports need attention.</p>
        {exports.filter(result => result.error).map(result => <p key={result.path} className="break-words">{result.agent}: {result.error}</p>)}
        <Button variant="secondary" size="sm" onClick={retryExports}>Retry exports</Button>
      </div>}
    </div>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {current && context ? <NoteEditor key={current.id} paneId={paneId} note={current} context={context} flush={flush} draftKey={`pane-note-draft:${paneId}:${viewId}:${current.id}`} capture={capture}
        viewedScope={scope} exports={exports} onExports={setExports} onRefresh={refresh} toolbar={toolbar} />
        : <div className="mx-auto mt-16 max-w-sm px-6 text-center">
          <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-tertiary text-text-secondary"><NotebookPen className="h-5 w-5" /></span>
          <h2 className="text-[15px] font-semibold text-text-primary">No notes here yet</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-tertiary">{capture
            ? 'Start a note for this terminal excerpt.'
            : scope ? descriptions[scope.kind] : 'Loading notes…'}</p>
          <Button className="mt-4" size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => void create()} disabled={!scope}>New note</Button>
        </div>}
    </div>
  </section>;
}

function NoteEditor({ paneId, note, context, flush, capture, onExports, onRefresh, draftKey, exports, viewedScope, toolbar }: {
  paneId: string; note: Note; context: NoteContext; draftKey: string; flush: React.MutableRefObject<(() => Promise<boolean>) | null>;
  exports: NoteExportResult[]; viewedScope?: NoteScope; toolbar: HTMLElement | null;
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
    }).catch(cause => { setError(ipcErrorMessage(cause, 'Pane did not say why.')); setStatus('Not saved'); return false; }).finally(() => { saving.current = null; });
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
    } catch (cause) { setError(ipcErrorMessage(cause, 'Pane did not say why.')); }
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
  const title = useRef<HTMLTextAreaElement>(null);
  useAutoHeight(title, draft.title);
  return <div className="notes-document">
    {toolbar && createPortal(<>
      {viewedScope && !sameNoteScope(draft.scope, viewedScope) && <span className="whitespace-nowrap px-1 text-[12px] text-text-tertiary">Reference to {scopeLabels[draft.scope.kind]}</span>}
      {/* A fixed slot, so the header never reflows as the status comes and goes. */}
      <span className="w-24 shrink-0 truncate px-1 text-right text-[12px]">
        <span role="status" className={error ? 'text-status-error' : status === 'Saved' && !recoveryWarning ? 'sr-only' : 'text-text-tertiary'}>{status}</span>
      </span>
      <Dropdown position="bottom-right" width="lg" menuClassName="!z-modal"
        trigger={<IconButton aria-label="Note settings" title="Note settings" className="gap-1.5"
          icon={<>{failedExports.length > 0 && <span className="text-[12px] text-status-error">Export issue</span>}<Settings size={16} /></>} />}
        items={[
          ...((draft.scope.kind === 'feature' || draft.scope.kind === 'session') ? (projects.length > 1
            ? projects.map(item => ({ id: `project-${item.scope.id}`, label: <span className="block whitespace-normal break-words">Move to {item.name}</span>, icon: ArrowUpRight, onClick: () => { void mutate('move', item.scope); } }))
            : [{ id: 'project', label: 'Move to Project Notes', icon: ArrowUpRight, disabled: !projects.length, onClick: () => { if (projects[0]) void mutate('move', projects[0].scope); } }]) : []),
          ...(draft.scope.kind === 'project' ? [{ id: 'global', label: 'Move to Global Notes', icon: ArrowUpRight, onClick: () => { void mutate('move', { kind: 'global', id: 'user' }); } }] : []),
          { id: 'delete', label: 'Delete note', icon: Trash2, variant: 'danger', onClick: () => { if (window.confirm('Delete this note and all its references?')) void mutate('remove'); } },
        ]}
        footer={failedExports.length > 0 ? <div role="alert" className="space-y-2 p-3 text-[13px] text-status-error">
          <p>Note saved. Agent exports need attention.</p>
          {failedExports.map(result => <p key={result.path} className="break-words">{result.agent}: {result.error}</p>)}
          <Button variant="secondary" size="sm" onClick={() => { void window.electronAPI.invoke('notes:mutate', paneId, { action: 'retry' }).then(result => onExports(result.exports)).catch(cause => setError(ipcErrorMessage(cause, 'Pane did not say why.'))); }}>Retry exports</Button>
        </div> : undefined} />
    </>, toolbar)}
    {recoveryWarning && <p role="status" className={`${alert} mb-4`}>{recoveryWarning}</p>}
    {error && <div role="alert" className={`${alert} mb-5`}>
      <p className="font-medium">{error}</p>
      <p>Your unsaved draft remains here. Copy it before reloading if you want to keep it.</p>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="secondary" size="sm" onClick={() => { setError(''); void save(); }}>Retry save</Button>
        <Button variant="secondary" size="sm" onClick={() => { void navigator.clipboard.writeText(JSON.stringify(draftRef.current, null, 2)); }}>Copy draft</Button>
        <Button variant="ghost" size="sm" onClick={() => { localStorage.removeItem(draftKey); dirty.current = false; draftRef.current = note; setDraft(note); setError(''); setStatus('Saved'); }}>Reload saved note</Button>
      </div>
    </div>}
    <textarea ref={title} aria-label="Note title" placeholder="Untitled" rows={1}
      className={`${field} notes-title mb-4 block resize-none overflow-hidden font-semibold tracking-tight`} value={draft.title}
      onChange={event => change({ ...draftRef.current, title: event.target.value.replace(/\n/g, ' ') })}
      onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
    {capture && !captured && <div className="mb-5 flex items-center gap-3 rounded-[12px] bg-surface-secondary px-3.5 py-3 ring-1 ring-border-secondary">
      <TerminalSquare className="h-4 w-4 shrink-0 text-text-tertiary" />
      <pre className="min-w-0 flex-1 truncate font-mono text-[12px] text-text-secondary">{capture.text.trim().split('\n')[0]}</pre>
      <Button size="sm" className="shrink-0" onClick={() => {
        change({ ...draftRef.current, blocks: [...draftRef.current.blocks, { type: 'text', id: crypto.randomUUID(), text: `Terminal excerpt · ${capture.source} · ${capture.at}\n\n${capture.text}` }] });
        setCaptured(true);
      }}>Add terminal excerpt to this note</Button>
    </div>}
    <div className="space-y-1">
      {draft.blocks.map((block, index) => <NoteContentBlock key={block.id} block={block} index={index}
        onChange={updateBlock} onText={() => addText(block.id)} onDrawing={() => addDrawing(block.id)}
        onRemove={() => change({ ...draftRef.current, blocks: draftRef.current.blocks.filter(item => item.id !== block.id) })}
        onEditDrawing={() => { if (block.type === 'drawing') { insertAfter.current = undefined; setDrawing(block); } }} />)}
      {draft.blocks.length === 0 && <Dropdown menuClassName="!z-modal" position="bottom-left" width="sm"
        trigger={<Button variant="ghost" size="sm" aria-label="Add block" icon={<Plus className="h-4 w-4" />} className="-ml-2.5">Add a block</Button>}
        items={[{ id: 'text', label: 'Text', icon: Type, onClick: () => addText() }, { id: 'drawing', label: 'Drawing', icon: Pencil, onClick: () => addDrawing() }]} />}
    </div>
    {drawing && <Suspense fallback={<p role="status" className="py-2 text-[13px] text-text-tertiary">Loading drawing editor…</p>}><DrawingEditor block={drawing}
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

/** Grows a textarea to fit its text, and refits when the column width changes. */
function useAutoHeight(ref: React.RefObject<HTMLTextAreaElement | null>, text: string) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => { element.style.height = 'auto'; element.style.height = `${element.scrollHeight}px`; };
    fit();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; fit(); }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text]);
}

function NoteContentBlock({ block, index, onChange, onText, onDrawing, onRemove, onEditDrawing }: {
  block: NoteBlock; index: number; onChange: (block: NoteBlock) => void;
  onText: () => void; onDrawing: () => void; onRemove: () => void; onEditDrawing: () => void;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const slash = useRef(false);
  useAutoHeight(textarea, block.type === 'text' ? block.text : '');
  return <div className="group relative py-0.5">
    <Dropdown className="absolute -left-8 top-1" menuClassName="!z-modal" position="bottom-left" width="sm"
      trigger={<button ref={add} type="button" aria-label={`Add block after block ${index + 1}`} title="Add block"
        className="notes-block-add flex h-6 w-6 items-center justify-center rounded-md text-text-tertiary opacity-0 transition-opacity hover:bg-surface-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus group-hover:opacity-100 group-focus-within:opacity-100"><Plus size={16} /></button>}
      onOpenChange={open => { if (!open && slash.current) { slash.current = false; requestAnimationFrame(() => textarea.current?.focus()); } }}
      items={[{ id: 'text', label: 'Text', icon: Type, onClick: () => { slash.current = false; onText(); } }, { id: 'drawing', label: 'Drawing', icon: Pencil, onClick: () => { slash.current = false; onDrawing(); } },
        { id: 'remove', label: 'Delete block', icon: Trash2, variant: 'danger', onClick: onRemove }]} />
    {block.type === 'text' ? <textarea ref={textarea} id={`note-block-${block.id}`} aria-label={`Text block ${index + 1}`} rows={1}
      className={`${field} notes-text block resize-none overflow-hidden py-1`} placeholder={index === 0 ? 'Write something, or type / for blocks…' : 'Write something…'}
      value={block.text} onChange={event => onChange({ ...block, text: event.target.value })}
      onKeyDown={event => {
        const cursor = event.currentTarget.selectionStart;
        if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && (cursor === 0 || /\s/.test(block.text[cursor - 1]))) {
          event.preventDefault(); slash.current = true; add.current?.click();
        }
      }} />
      : <button type="button" aria-label={`${block.title} · Edit drawing`} className="block w-full rounded-[12px] p-2 text-left ring-1 ring-transparent hover:ring-border-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus" onClick={onEditDrawing}>
        {block.png && <img src={block.png} alt={block.labels || block.title} className="mx-auto max-h-96 max-w-full rounded-md" />}
        <span className="mt-1.5 block text-[12px] text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{block.title} · Edit drawing</span>
      </button>}
  </div>;
}
