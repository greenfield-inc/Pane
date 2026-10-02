import { File, Eye, Code } from 'lucide-react';
import type { GitFileStatus } from './editorFileIo';
import type { EditorViewMode } from './fileEditorState';

interface FileEditorHeaderProps {
  filePath: string;
  hasUnsavedChanges: boolean;
  gitStatus: GitFileStatus;
  /** HTML files get a "Preview as HTML" action (opens the browser tab). */
  onPreviewHtml?: () => void;
  /** Markdown / notebooks can switch between the editor and a rendered preview. */
  viewMode?: EditorViewMode;
  onViewModeChange?: (mode: EditorViewMode) => void;
  /** Text files show the auto-save state; binary previews do not. */
  showSaveState: boolean;
}

export function FileEditorHeader({
  filePath,
  hasUnsavedChanges,
  gitStatus,
  onPreviewHtml,
  viewMode,
  onViewModeChange,
  showSaveState,
}: FileEditorHeaderProps) {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-surface-secondary border-b border-border-primary">
      <div className="flex min-w-0 items-center gap-2">
        {onPreviewHtml && (
          <button
            type="button"
            onClick={onPreviewHtml}
            className="flex flex-shrink-0 items-center gap-1 rounded-lg border border-border-primary bg-surface-tertiary px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            title="Preview file as HTML"
            aria-label="Preview file as HTML"
          >
            <Eye className="w-3 h-3" />
            Preview as HTML
          </button>
        )}
        <File className="w-4 h-4 text-text-tertiary" />
        <span className="select-text min-w-0 truncate text-sm text-text-primary">
          {filePath}
          {hasUnsavedChanges && <span className="text-status-warning ml-2">●</span>}
        </span>
        {gitStatus !== 'clean' && (
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
            gitStatus === 'untracked'
              ? 'bg-status-success text-text-on-status-success'
              : 'bg-interactive text-text-on-interactive'
          }`}>
            {gitStatus === 'untracked' ? 'U' : 'M'}
          </span>
        )}
      </div>
      <div className="flex flex-shrink-0 items-center gap-2">
        {viewMode && onViewModeChange && (
          <div className="flex items-center rounded-lg border border-border-primary bg-surface-tertiary">
            <button
              type="button"
              onClick={() => onViewModeChange('edit')}
              className={`px-2 py-1 text-xs font-medium rounded-l-lg transition-colors flex items-center gap-1 ${
                viewMode === 'edit'
                  ? 'bg-interactive text-text-on-interactive'
                  : 'text-text-secondary hover:bg-surface-hover'
              }`}
              title="Edit mode"
            >
              <Code className="w-3 h-3" />
              Edit
            </button>
            <button
              type="button"
              onClick={() => onViewModeChange('preview')}
              className={`px-2 py-1 text-xs font-medium rounded-r-lg transition-colors flex items-center gap-1 ${
                viewMode === 'preview'
                  ? 'bg-interactive text-text-on-interactive'
                  : 'text-text-secondary hover:bg-surface-hover'
              }`}
              title="Preview mode"
            >
              <Eye className="w-3 h-3" />
              Preview
            </button>
          </div>
        )}
        {showSaveState && (
          <div className="flex items-center gap-2 text-sm">
            {hasUnsavedChanges ? (
              <>
                <div className="w-2 h-2 bg-status-warning rounded-full animate-pulse" />
                <span className="text-status-warning">Auto-saving...</span>
              </>
            ) : (
              <>
                <div className="w-2 h-2 bg-status-success rounded-full" />
                <span className="text-status-success">All changes saved</span>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
