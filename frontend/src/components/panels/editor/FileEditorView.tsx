/**
 * FileEditorView: the editor half of the old Explorer split. Renders one file
 * (Monaco, markdown/notebook preview, image or PDF) for a center `editor`
 * tab. The tree that opens files lives in the Files inspector (FileEditor).
 */
import { useEffect, useCallback, useMemo, useRef, useReducer } from 'react';
import Editor from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { MonacoErrorBoundary } from '../../MonacoErrorBoundary';
import { isLightTheme, useTheme } from '../../../contexts/ThemeContext';
import { debounce } from '../../../utils/debounce';
import { subscribeToSessionGitChanges } from '../../../utils/session-git-events';
import { useCommittedRef } from '../../../hooks/useCommittedRef';
import { MarkdownPreview } from '../../MarkdownPreview';
import { NotebookPreview } from './NotebookPreview';
import type { EditorPanelState } from '../../../../../shared/types/panels';
import { isHtmlFile } from './htmlFile';
import { previewHtmlFileInBrowser } from './previewHtmlFile';
import { fileExtension, getLanguageFromPath, IMAGE_EXTENSIONS, PDF_EXTENSIONS } from './fileKinds';
import { fetchGitFileStatus, isBinaryPath, readEditorFile, type FileItem } from './editorFileIo';
import { fileEditorReducer, initialFileEditorState } from './fileEditorState';
import { restoreEditorPosition, trackEditorPosition, type PositionTracker } from './monacoPosition';
import { FileEditorHeader } from './FileEditorHeader';
import { BinaryFilePreview } from './BinaryFilePreview';

export interface FileEditorViewProps {
  sessionId: string;
  filePath: string;
  initialState?: EditorPanelState;
  onFileChange?: (filePath: string | undefined, isDirty: boolean) => void;
  onStateChange?: (state: Partial<EditorPanelState>) => void;
  /** Fired when the user edits or saves (⌘S) the file — pins preview tabs. */
  onUserEdit?: () => void;
}

export function FileEditorView({
  sessionId,
  filePath,
  initialState,
  onFileChange,
  onStateChange,
  onUserEdit,
}: FileEditorViewProps) {
  const [state, dispatch] = useReducer(fileEditorReducer, initialFileEditorState);
  const { selectedFile, fileContent, originalContent, loading, error, gitStatus, binaryBlobUrl, viewMode } = state;
  const selectedFilePathRef = useCommittedRef(selectedFile?.path ?? null);
  const onStateChangeRef = useCommittedRef(onStateChange);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // Monotonic load id: a load that finishes after the tab was re-targeted is stale.
  const loadSeqRef = useRef(0);
  // Debounced cursor/scroll saves, so a re-target can drop the old file's.
  const positionTrackerRef = useRef<PositionTracker | null>(null);

  // Clean up blob URLs when they are replaced or the tab closes
  useEffect(() => () => {
    if (binaryBlobUrl) URL.revokeObjectURL(binaryBlobUrl);
  }, [binaryBlobUrl]);

  const { theme } = useTheme();
  const isDarkMode = !isLightTheme(theme);
  const hasUnsavedChanges = fileContent !== originalContent;

  const ext = selectedFile ? fileExtension(selectedFile.path) : '';
  const isMarkdownFile = ext === 'md' || ext === 'markdown';
  const isNotebookFile = ext === 'ipynb';
  const isImageFile = IMAGE_EXTENSIONS.has(ext);
  const isPdfFile = PDF_EXTENSIONS.has(ext);
  const isBinaryPreview = isImageFile || isPdfFile;

  const previewHtmlFile = useCallback(async (path: string) => {
    dispatch({ type: 'error', message: null });
    try {
      await previewHtmlFileInBrowser(sessionId, path);
    } catch (previewError) {
      dispatch({ type: 'error', message: previewError instanceof Error ? previewError.message : 'Failed to preview HTML file' });
    }
  }, [sessionId]);

  const refreshGitStatus = useCallback((path: string) => {
    void fetchGitFileStatus(sessionId, path).then((status) => {
      if (status && mountedRef.current && selectedFilePathRef.current === path) {
        dispatch({ type: 'git-status', status });
      }
    });
  }, [sessionId, selectedFilePathRef]);

  const loadFile = useCallback(async (file: FileItem) => {
    const seq = ++loadSeqRef.current;
    dispatch({ type: 'load-start' });
    try {
      const loaded = await readEditorFile(sessionId, file.path);
      if (seq !== loadSeqRef.current) {
        // Superseded by a re-target: nothing will own this blob, release it.
        if (loaded.kind === 'binary') URL.revokeObjectURL(loaded.blobUrl);
        return;
      }

      if (loaded.kind === 'error' && !isBinaryPath(file.path)) {
        dispatch({ type: 'load-failed', message: loaded.message });
        return;
      }
      if (loaded.kind === 'text') {
        dispatch({ type: 'load-text', file, content: loaded.content });
      } else {
        // A failed image/PDF read still shows the header, with the error under it.
        dispatch({
          type: 'load-binary',
          file,
          blobUrl: loaded.kind === 'binary' ? loaded.blobUrl : null,
          error: loaded.kind === 'error' ? loaded.message : undefined,
        });
      }
      onFileChange?.(file.path, false);
      onStateChange?.({ filePath: file.path, isDirty: false });

      // A reload of the tab's own file (same path) restores its saved position.
      if (loaded.kind === 'text' && editorRef.current && initialState?.filePath === file.path) {
        restoreEditorPosition(editorRef.current, initialState);
      }
    } catch (err) {
      if (seq === loadSeqRef.current) {
        dispatch({ type: 'load-failed', message: err instanceof Error ? err.message : 'Failed to load file' });
      }
    }
  }, [sessionId, onFileChange, onStateChange, initialState]);

  // Git badge: on load, and again when git or the file system moves underneath
  useEffect(() => {
    if (!selectedFile) return;
    refreshGitStatus(selectedFile.path);
    return subscribeToSessionGitChanges(sessionId, () => refreshGitStatus(selectedFile.path));
  }, [selectedFile, refreshGitStatus, sessionId]);

  const handleEditorMount = (editor: monaco.editor.IStandaloneCodeEditor) => {
    editorRef.current = editor;
    positionTrackerRef.current = trackEditorPosition(editor, (next) => onStateChangeRef.current?.(next));
    restoreEditorPosition(editor, initialState);
  };

  // Auto-save functionality
  const pendingAutoSaveFilePathRef = useRef<string | null>(null);
  const autoSave = useMemo(
    () => debounce(async (file: FileItem, content: string) => {
      pendingAutoSaveFilePathRef.current = null;
      try {
        const result = await window.electronAPI.invoke('file:write', {
          sessionId,
          filePath: file.path,
          content,
        });
        const isActiveFile = mountedRef.current && selectedFilePathRef.current === file.path;
        if (result.success) {
          if (isActiveFile) {
            dispatch({ type: 'saved', content });
            onFileChange?.(file.path, false);
            onStateChange?.({ filePath: file.path, isDirty: false });
          }
          refreshGitStatus(file.path);
        } else if (mountedRef.current) {
          dispatch({ type: 'error', message: result.error });
        }
      } catch (err) {
        if (mountedRef.current) {
          dispatch({ type: 'error', message: err instanceof Error ? err.message : 'Failed to auto-save file' });
        }
      }
    }, 1000), // Auto-save after 1 second of inactivity
    [sessionId, onFileChange, onStateChange, refreshGitStatus, selectedFilePathRef],
  );
  // Flush per instance: `autoSave` is rebuilt when a callback prop changes
  // (the tab renames itself on the first dirty keystroke), and an outgoing
  // instance's armed timer would otherwise fire later with older content.
  useEffect(() => () => autoSave.flush(), [autoSave]);
  const autoSaveRef = useCommittedRef(autoSave);

  // ⌘S / Ctrl+S: write any pending edit now and pin the tab (VS Code pins
  // preview editors on save, whether or not anything changed).
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's' || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      autoSaveRef.current.flush();
      onUserEdit?.();
    };
    container.addEventListener('keydown', handleKeyDown, true);
    return () => container.removeEventListener('keydown', handleKeyDown, true);
  }, [autoSaveRef, onUserEdit]);

  const handleEditorChange = (value: string | undefined) => {
    const content = value || '';
    dispatch({ type: 'edit', content });
    if (!selectedFile || selectedFile.isDirectory) return;

    const isDirty = content !== originalContent;
    if (isDirty) onUserEdit?.();
    onFileChange?.(selectedFile.path, isDirty);
    if (isDirty) {
      if (pendingAutoSaveFilePathRef.current && pendingAutoSaveFilePathRef.current !== selectedFile.path) {
        autoSave.flush();
      }
      pendingAutoSaveFilePathRef.current = selectedFile.path;
      autoSave(selectedFile, content);
    } else if (pendingAutoSaveFilePathRef.current === selectedFile.path) {
      autoSave.cancel();
      pendingAutoSaveFilePathRef.current = null;
    }
  };

  // Load the file this tab points at (and reload when it is re-targeted)
  useEffect(() => {
    // Any load still in flight is for a path the tab no longer points at.
    // Invalidate it before the same-path check: A → B → A while B is loading
    // must not let B's response land on top of the A that is still shown.
    loadSeqRef.current += 1;
    if (selectedFile?.path === filePath) return;
    autoSave.flush();
    positionTrackerRef.current?.cancel();
    void loadFile({ name: filePath.split('/').pop() || '', path: filePath, isDirectory: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath]);

  // Terminal links / re-opens can ask for a specific position. Matched by
  // file path; a tab that mounts after the request restores the position
  // from its persisted panel state instead.
  useEffect(() => {
    const handleReveal = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const { cursorPosition, filePath: target } = event.detail || {};
      if (target !== filePath || !cursorPosition || !editorRef.current) return;
      editorRef.current.setPosition({ lineNumber: cursorPosition.line, column: cursorPosition.column });
      editorRef.current.revealPositionInCenter({ lineNumber: cursorPosition.line, column: cursorPosition.column });
      editorRef.current.focus();
    };
    window.addEventListener('editor-panel:reveal', handleReveal);
    return () => window.removeEventListener('editor-panel:reveal', handleReveal);
  }, [filePath]);

  // Dispose the Monaco model when the file changes or the tab unmounts
  useEffect(() => {
    return () => {
      try {
        editorRef.current?.getModel()?.dispose();
      } catch (cleanupError) {
        console.warn('[FileEditorView] Error during Monaco cleanup:', cleanupError);
      }
    };
  }, [selectedFile?.path]);

  if (!selectedFile) {
    return (
      <div ref={containerRef} className="h-full w-full min-w-0 flex flex-col overflow-hidden">
        <div className="flex-1 flex items-center justify-center text-text-secondary">
          {error ? `Error: ${error}` : loading ? 'Loading...' : 'Select a file to edit'}
        </div>
      </div>
    );
  }

  const canToggleMode = !isBinaryPreview && (isMarkdownFile || isNotebookFile);
  const fileName = selectedFile.path.split('/').pop() || 'Image';

  return (
    <div ref={containerRef} className="h-full w-full min-w-0 flex flex-col overflow-hidden">
      <FileEditorHeader
        filePath={selectedFile.path}
        hasUnsavedChanges={hasUnsavedChanges}
        gitStatus={gitStatus}
        onPreviewHtml={isHtmlFile(selectedFile.path) ? () => previewHtmlFile(selectedFile.path) : undefined}
        viewMode={canToggleMode ? viewMode : undefined}
        onViewModeChange={canToggleMode ? (mode) => dispatch({ type: 'view-mode', mode }) : undefined}
        showSaveState={!isBinaryPreview}
      />
      {error && (
        <div role="alert" className="px-4 py-2 bg-status-error/20 text-status-error text-sm">
          Error: {error}
        </div>
      )}
      <div className="flex-1 min-w-0 overflow-hidden">
        {viewMode === 'preview' && isMarkdownFile ? (
          <div className="h-full overflow-auto bg-bg-primary">
            <MarkdownPreview
              content={fileContent}
              className="min-h-full"
              id={`file-editor-preview-${sessionId}-${selectedFile.path.replace(/[^a-zA-Z0-9]/g, '-')}`}
            />
          </div>
        ) : viewMode === 'preview' && isNotebookFile ? (
          <div className="h-full overflow-auto bg-bg-primary">
            <NotebookPreview content={fileContent} className="min-h-full" />
          </div>
        ) : isBinaryPreview && (binaryBlobUrl || !error) ? (
          <BinaryFilePreview kind={isImageFile ? 'image' : 'pdf'} blobUrl={binaryBlobUrl} fileName={fileName} />
        ) : (
          <MonacoErrorBoundary>
            <Editor
              theme={isDarkMode ? 'vs-dark' : 'light'}
              value={fileContent}
              onChange={handleEditorChange}
              onMount={handleEditorMount}
              options={{
                minimap: { enabled: true },
                fontSize: 14,
                wordWrap: 'on',
                automaticLayout: true,
              }}
              language={getLanguageFromPath(selectedFile.path)}
            />
          </MonacoErrorBoundary>
        )}
      </div>
    </div>
  );
}
