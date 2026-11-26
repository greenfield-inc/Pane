import { lazy, Suspense } from 'react';
import type * as monaco from 'monaco-editor';
import { isLightTheme, useTheme } from '../../contexts/ThemeContext';
import { MonacoErrorBoundary } from '../MonacoErrorBoundary';
import { CodeSkeleton } from '../panels/editor/DocumentFilePreview';
import { getLanguageFromPath } from '../panels/editor/fileKinds';
import { useCommittedRef } from '../../hooks/useCommittedRef';

const Editor = lazy(() => import('@monaco-editor/react'));

/**
 * A profile file's source in Edit (build 8 feedback 3): the editor a file tab uses, so ⌘F, ⌘G and
 * the rest of its find work here as they do there. ⌘S saves; Esc cancels once the editor's own find
 * or suggestions are closed.
 */
export function ProfileSourceEditor({ path, label, value, readOnly, onChange, onSave, onCancel }: {
  path: string;
  label: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { theme } = useTheme();
  const onSaveRef = useCommittedRef(onSave);
  const onCancelRef = useCommittedRef(onCancel);

  const mount = (editor: monaco.editor.IStandaloneCodeEditor, api: typeof monaco) => {
    editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () => onSaveRef.current());
    editor.addCommand(api.KeyCode.Escape, () => onCancelRef.current(), '!findWidgetVisible && !suggestWidgetVisible && !inSnippetMode');
    editor.focus();
  };

  return (
    <div className="min-h-0 flex-1" data-testid="profiles-editor">
      <MonacoErrorBoundary>
        <Suspense fallback={<CodeSkeleton label="Loading the editor" />}>
          <Editor
            theme={isLightTheme(theme) ? 'light' : 'vs-dark'}
            value={value}
            onChange={next => onChange(next ?? '')}
            onMount={mount}
            language={getLanguageFromPath(path)}
            loading={<CodeSkeleton label="Loading the editor" />}
            options={{ ariaLabel: label, readOnly, minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', automaticLayout: true, scrollBeyondLastLine: false }}
          />
        </Suspense>
      </MonacoErrorBoundary>
    </div>
  );
}
