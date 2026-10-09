import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronRight, ExternalLink, File, Folder, Loader2, RotateCw } from 'lucide-react';
import type { ListeningPortsSnapshot } from '../../../../shared/types/listeningPorts';
import { filePreviewKind, type FilePreviewKind } from '../../../../shared/utils/filePreview';
import { cn } from '../../utils/cn';
import type { RemoteFileEntry, RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';
import { isNativeMobile, openNativeExternalUrl } from '../runtime/nativeMobile';
import { phoneMediaUrl } from '../utils/phonePage';

interface RemoteExplorerPanelProps {
  adapter: RemoteRuntimeAdapter;
  panelId: string;
  sessionId: string;
  /** The host's phone addresses; media previews load from its files address. */
  ports: ListeningPortsSnapshot | null;
  onError(message: string): void;
}

const TOOL_BUTTON = 'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40';
const MEDIA_KINDS: ReadonlySet<FilePreviewKind> = new Set(['image', 'pdf', 'video', 'audio']);
/** Larger text files stay on the desktop: a phone text area slows to a crawl well before this. */
const MAX_EDIT_BYTES = 1024 * 1024;

// Switching tabs or panes unmounts the Explorer. These keep its open file, by panel, and its
// unsaved drafts and in-flight saves, by pane and path, until the app closes.
const openFiles = new Map<string, RemoteFileEntry>();
const unsavedDrafts = new Map<string, TextState>();
/** Resolves to null once `content` is on the host, or to the reason it is not. */
const pendingSaves = new Map<string, { content: string; done: Promise<string | null> }>();

/**
 * Writes `content` and, when it lands, marks it saved in the cached draft, so a save that
 * outlives its editor still updates what the next editor shows.
 */
function startSave(key: string, content: string, write: () => Promise<void>) {
  const done = write().then(
    () => {
      const cached = unsavedDrafts.get(key);
      if (cached?.kind === 'text') {
        if (cached.draft === content) unsavedDrafts.delete(key);
        else unsavedDrafts.set(key, { ...cached, saved: content });
      }
      return null;
    },
    (error: Error) => error.message || 'Could not save the file.',
  ).finally(() => pendingSaves.delete(key));
  const pending = { content, done };
  pendingSaves.set(key, pending);
  return pending;
}

/**
 * The phone's Explorer tab: the pane's worktree as a tree, a text editor that saves to the host,
 * and previews for images, PDFs, video and audio from the host's phone files address.
 */
export function RemoteExplorerPanel({ adapter, panelId, sessionId, ports, onError }: RemoteExplorerPanelProps) {
  const [folders, setFolders] = useState<Record<string, RemoteFileEntry[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [openFile, setOpenFileState] = useState<RemoteFileEntry | null>(() => openFiles.get(panelId) ?? null);
  const setOpenFile = (file: RemoteFileEntry | null) => {
    if (file) openFiles.set(panelId, file);
    else openFiles.delete(panelId);
    setOpenFileState(file);
  };
  const [refreshing, setRefreshing] = useState(false);

  const loadFolder = useCallback(async (path: string) => {
    try {
      const entries = await adapter.listFiles(sessionId, path);
      setFolders(previous => ({ ...previous, [path]: entries }));
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not list files.');
    }
  }, [adapter, sessionId, onError]);

  useEffect(() => {
    void loadFolder('');
  }, [loadFolder]);

  const toggleFolder = (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      if (!folders[path]) void loadFolder(path);
    }
    setExpanded(next);
  };

  const refresh = async () => {
    setRefreshing(true);
    // Collapsed folders load again when next opened.
    setFolders(previous => Object.fromEntries(Object.entries(previous).filter(([path]) => path === '' || expanded.has(path))));
    try {
      await Promise.all(['', ...expanded].map(loadFolder));
    } finally {
      setRefreshing(false);
    }
  };

  if (openFile) {
    const kind = filePreviewKind(openFile.path);
    const close = () => setOpenFile(null);
    return kind && MEDIA_KINDS.has(kind)
      ? <MediaFileView file={openFile} kind={kind} media={phoneMediaUrl(openFile.path, ports, sessionId)} onBack={close} onError={onError} />
      : <TextFileView adapter={adapter} sessionId={sessionId} file={openFile} onBack={close} onError={onError} />;
  }

  const renderFolder = (path: string, depth: number) => {
    const entries = folders[path];
    if (!entries) return <p className="py-2 text-xs text-text-tertiary" style={{ paddingLeft: rowIndent(depth) }}>Loading…</p>;
    if (entries.length === 0) return <p className="py-2 text-xs text-text-tertiary" style={{ paddingLeft: rowIndent(depth) }}>Empty folder</p>;
    return entries.map(entry => {
      const isOpen = entry.isDirectory && expanded.has(entry.path);
      return (
        <div key={entry.path}>
          <button
            type="button"
            aria-label={entry.name}
            aria-expanded={entry.isDirectory ? isOpen : undefined}
            onClick={() => (entry.isDirectory ? toggleFolder(entry.path) : setOpenFile(entry))}
            className="flex h-10 w-full items-center gap-2 pr-3 text-left text-sm text-text-primary hover:bg-surface-hover"
            style={{ paddingLeft: rowIndent(depth) }}
          >
            {entry.isDirectory
              ? <ChevronRight className={cn('h-4 w-4 flex-shrink-0 text-text-tertiary', isOpen && 'rotate-90')} aria-hidden="true" />
              : <span className="h-4 w-4 flex-shrink-0" aria-hidden="true" />}
            {entry.isDirectory
              ? <Folder className="h-4 w-4 flex-shrink-0 text-text-secondary" aria-hidden="true" />
              : <File className="h-4 w-4 flex-shrink-0 text-text-tertiary" aria-hidden="true" />}
            <span className="min-w-0 truncate">{entry.name}</span>
          </button>
          {isOpen && renderFolder(entry.path, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-primary">
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border-primary bg-bg-secondary px-3 py-1.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">Files</h2>
        <button type="button" className={TOOL_BUTTON} aria-label="Refresh files" title="Refresh files" disabled={refreshing} onClick={() => void refresh()}>
          {/* The spinner and the refresh icon share one box. */}
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">{renderFolder('', 0)}</div>
    </div>
  );
}

function rowIndent(depth: number): string {
  return `${0.5 + depth * 0.875}rem`;
}

type TextState =
  | { kind: 'loading' }
  /** A text area holds `\n` line endings only; `lineEnding` is the file's own, restored on save. */
  | { kind: 'text'; saved: string; draft: string; lineEnding: '\n' | '\r\n' }
  | { kind: 'notice'; message: string };

/** A worktree text file in a text area; Save writes it to the host. */
function TextFileView({ adapter, sessionId, file, onBack, onError }: {
  adapter: RemoteRuntimeAdapter;
  sessionId: string;
  file: RemoteFileEntry;
  onBack(): void;
  onError(message: string): void;
}) {
  const draftKey = `${sessionId}\0${file.path}`;
  const [text, setText] = useState<TextState>(() => unsavedDrafts.get(draftKey) ?? { kind: 'loading' });
  const [saving, setSaving] = useState(() => pendingSaves.has(draftKey));
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dirty = text.kind === 'text' && text.draft !== text.saved;

  /** Waits for a save, this editor's or one an earlier visit started, and shows how it ended. */
  const follow = useCallback((pending: { content: string; done: Promise<string | null> }) => {
    let active = true;
    setSaving(true);
    void pending.done.then(error => {
      if (!active) return;
      setSaving(false);
      if (error) {
        onError(error);
        return;
      }
      setText(current => (current.kind === 'text' ? { ...current, saved: pending.content } : current));
      setConfirmingDiscard(false);
    });
    return () => { active = false; };
  }, [onError]);

  useEffect(() => {
    const pending = pendingSaves.get(draftKey);
    return pending ? follow(pending) : undefined;
  }, [draftKey, follow]);

  useEffect(() => {
    if (dirty) unsavedDrafts.set(draftKey, text);
    else unsavedDrafts.delete(draftKey);
  }, [draftKey, dirty, text]);

  useEffect(() => {
    // An unsaved draft from an earlier visit wins over the host's copy.
    if (unsavedDrafts.has(draftKey)) return;
    if ((file.size ?? 0) > MAX_EDIT_BYTES) {
      setText({ kind: 'notice', message: `${file.name} is larger than 1 MB. Open it on a desktop.` });
      return;
    }
    let cancelled = false;
    adapter.readTextFile(sessionId, file.path).then(
      content => {
        if (cancelled) return;
        if (content === null) {
          setText({ kind: 'notice', message: `${file.name} is a binary file with no phone preview.` });
          return;
        }
        const normalized = content.replace(/\r\n/gu, '\n');
        setText({ kind: 'text', saved: normalized, draft: normalized, lineEnding: normalized === content ? '\n' : '\r\n' });
      },
      (error: Error) => { if (!cancelled) setText({ kind: 'notice', message: error.message }); },
    );
    return () => { cancelled = true; };
  }, [adapter, sessionId, file, draftKey]);

  const save = () => {
    // One write per file at a time, so an older save can never land after a newer one.
    if (text.kind !== 'text' || pendingSaves.has(draftKey)) return;
    const content = text.draft;
    const onDisk = text.lineEnding === '\n' ? content : content.replace(/\n/gu, '\r\n');
    follow(startSave(draftKey, content, () => adapter.writeTextFile(sessionId, file.path, onDisk)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-primary">
      <FileHeader file={file} dirty={dirty} onBack={() => (dirty ? setConfirmingDiscard(true) : onBack())}>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={save}
          className="flex h-8 w-16 flex-shrink-0 items-center justify-center rounded-md bg-interactive text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:bg-surface-secondary disabled:text-text-tertiary"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-label="Saving" /> : 'Save'}
        </button>
      </FileHeader>

      {confirmingDiscard && (
        <div role="alert" className="flex flex-shrink-0 items-center gap-2 border-b border-border-primary bg-surface-secondary px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 text-text-secondary">Unsaved changes</span>
          <button type="button" className="rounded-md px-2 py-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary" onClick={() => { unsavedDrafts.delete(draftKey); onBack(); }}>Discard</button>
          <button type="button" className="rounded-md px-2 py-1 font-medium text-interactive hover:bg-surface-hover" onClick={() => setConfirmingDiscard(false)}>Keep editing</button>
        </div>
      )}

      {text.kind === 'loading' && <Notice message="Loading…" />}
      {text.kind === 'notice' && <Notice message={text.message} />}
      {text.kind === 'text' && (
        <textarea
          aria-label={file.path}
          value={text.draft}
          onChange={event => {
            const draft = event.target.value;
            setText(current => (current.kind === 'text' ? { ...current, draft } : current));
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          // 16px keeps iOS from zooming the page when the text area takes focus.
          className="min-h-0 w-full flex-1 resize-none border-0 bg-bg-primary p-3 font-mono text-base leading-snug text-text-primary focus:outline-none"
        />
      )}
    </div>
  );
}

/** An image, PDF, video or audio file, streamed from the host's files address with Range support. */
function MediaFileView({ file, kind, media, onBack, onError }: {
  file: RemoteFileEntry;
  kind: FilePreviewKind;
  media: { url: string } | { reason: string };
  onBack(): void;
  onError(message: string): void;
}) {
  const url = 'url' in media ? media.url : null;
  // Kept by address, so a new files address after phone pages recover loads again.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = url !== null && failedUrl === url;
  const setFailed = () => setFailedUrl(url);
  const openOutside = () => {
    if (!url) return;
    if (isNativeMobile()) openNativeExternalUrl(url).catch(() => onError('Could not open the file outside Pane.'));
    else window.open(url, '_blank', 'noopener,noreferrer');
  };

  let body: ReactNode;
  if (!url) body = <Notice message={'reason' in media ? media.reason : ''} />;
  else if (failed) body = <Notice message="This file did not load. Try Open in Safari." />;
  // The files address answers with a CSP sandbox; a sandbox attribute here would also stop the PDF viewer.
  else if (kind === 'pdf') body = <iframe src={url} title={file.path} className="min-h-0 w-full flex-1 border-0 bg-surface-primary" />;
  else {
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface-primary p-3">
        {kind === 'image' && <img src={url} alt={file.path} onError={setFailed} className="max-h-full max-w-full object-contain" />}
        {/* Worktree media has no caption files to offer. */}
        {kind === 'video' && <video src={url} aria-label={file.path} controls playsInline preload="metadata" onError={setFailed} className="max-h-full w-full" />}
        {kind === 'audio' && <audio src={url} aria-label={file.path} controls preload="metadata" onError={setFailed} className="w-full" />}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-primary">
      <FileHeader file={file} onBack={onBack}>
        <button type="button" className={TOOL_BUTTON} aria-label="Open in Safari" title="Open in Safari" disabled={!url} onClick={openOutside}>
          <ExternalLink className="h-4 w-4" />
        </button>
      </FileHeader>
      {body}
    </div>
  );
}

function FileHeader({ file, dirty = false, onBack, children }: { file: RemoteFileEntry; dirty?: boolean; onBack(): void; children: ReactNode }) {
  return (
    <div className="flex flex-shrink-0 items-center gap-1 border-b border-border-primary bg-bg-secondary px-2 py-1.5">
      <button type="button" className={TOOL_BUTTON} aria-label="Back to files" title="Back to files" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" />
      </button>
      <p className="min-w-0 flex-1 truncate text-sm text-text-primary" title={file.path}>
        {file.name}
        {dirty && <span className="ml-1 text-text-tertiary" aria-label="unsaved">•</span>}
      </p>
      {children}
    </div>
  );
}

function Notice({ message }: { message: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <p className="max-w-sm text-center text-sm text-text-secondary">{message}</p>
    </div>
  );
}
