/**
 * State of one editor tab. A file load changes several fields at once
 * (file, content, blob, mode, loading, error), so they move together here.
 */
import type { FileItem, GitFileStatus } from './editorFileIo';

export type EditorViewMode = 'edit' | 'preview';

export interface FileEditorState {
  selectedFile: FileItem | null;
  fileContent: string;
  originalContent: string;
  loading: boolean;
  error: string | null;
  gitStatus: GitFileStatus;
  /** Object URL for an image/PDF; null while loading or for text files. */
  binaryBlobUrl: string | null;
  viewMode: EditorViewMode;
}

export const initialFileEditorState: FileEditorState = {
  selectedFile: null,
  fileContent: '',
  originalContent: '',
  loading: false,
  error: null,
  gitStatus: 'clean',
  binaryBlobUrl: null,
  viewMode: 'edit',
};

export type FileEditorAction =
  | { type: 'load-start' }
  | { type: 'load-cancelled' }
  | { type: 'load-text'; file: FileItem; content: string }
  | { type: 'load-binary'; file: FileItem; blobUrl: string | null; error?: string }
  | { type: 'load-failed'; message: string }
  | { type: 'edit'; content: string }
  | { type: 'saved'; content: string }
  | { type: 'error'; message: string | null }
  | { type: 'git-status'; status: GitFileStatus }
  | { type: 'view-mode'; mode: EditorViewMode };

export function fileEditorReducer(state: FileEditorState, action: FileEditorAction): FileEditorState {
  switch (action.type) {
    case 'load-start':
      return { ...state, loading: true, error: null, gitStatus: 'clean' };
    case 'load-text':
      return {
        ...state,
        selectedFile: action.file,
        fileContent: action.content,
        originalContent: action.content,
        binaryBlobUrl: null,
        viewMode: 'edit',
        loading: false,
      };
    case 'load-binary':
      return {
        ...state,
        selectedFile: action.file,
        fileContent: '',
        originalContent: '',
        binaryBlobUrl: action.blobUrl,
        error: action.error ?? null,
        viewMode: 'edit',
        loading: false,
      };
    case 'load-cancelled':
      return { ...state, loading: false };
    case 'load-failed':
      return { ...state, error: action.message, loading: false };
    case 'edit':
      return { ...state, fileContent: action.content };
    case 'saved':
      return { ...state, originalContent: action.content };
    case 'error':
      return { ...state, error: action.message };
    case 'git-status':
      return { ...state, gitStatus: action.status };
    case 'view-mode':
      return { ...state, viewMode: action.mode };
  }
}
