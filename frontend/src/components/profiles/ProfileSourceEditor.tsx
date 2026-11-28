import { lazy, Suspense, useEffect, useState, type KeyboardEvent } from 'react';
import type * as monaco from 'monaco-editor';
import { isLightTheme, useTheme } from '../../contexts/ThemeContext';
import { MonacoErrorBoundary } from '../MonacoErrorBoundary';
import { CodeSkeleton } from '../panels/editor/DocumentFilePreview';
import { getLanguageFromPath } from '../panels/editor/fileKinds';
import { useCommittedRef } from '../../hooks/useCommittedRef';

const Editor = lazy(() => import('@monaco-editor/react'));

/**
 * Whether Monaco failed to load (#1762 F-4): its loader fetches the editor from a CDN, and the
 * wrapper only logs a failure, leaving "Loading the editor" up for good when it is offline or blocked.
 */
function useMonacoFailed(): boolean {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    import('@monaco-editor/react').then(module => module.loader.init()).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  return failed;
}

/**
 * A profile file's source in Edit (build 8 feedback 3): the editor a file tab uses, so ⌘F, ⌘G and
 * the rest of its find work here as they do there. ⌘S saves; Esc cancels once the editor's own find
 * or suggestions are closed. When the editor can't load, a plain text box takes its place, with the
 * same ⌘S and Esc, so a profile can still be edited offline.
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
  const failed = useMonacoFailed();

  const mount = (editor: monaco.editor.IStandaloneCodeEditor, api: typeof monaco) => {
    editor.addCommand(api.KeyMod.CtrlCmd | api.KeyCode.KeyS, () => onSaveRef.current());
    editor.addCommand(api.KeyCode.Escape, () => onCancelRef.current(), '!findWidgetVisible && !suggestWidgetVisible && !inSnippetMode');
    editor.focus();
  };

  const plainKeys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); onSaveRef.current(); }
    else if (event.key === 'Escape') { event.preventDefault(); onCancelRef.current(); }
  };

  return (
    <div className="min-h-0 flex-1" data-testid="profiles-editor">
      {failed ? (
        <textarea
          aria-label={label}
          data-testid="profiles-plain-editor"
          autoFocus
          spellCheck={false}
          readOnly={readOnly}
          value={value}
          onChange={event => onChange(event.target.value)}
          onKeyDown={plainKeys}
          className="block h-full w-full resize-none border-0 bg-bg-primary px-6 py-4 font-mono text-[13px] text-text-primary focus:outline-none"
        />
      ) : (
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
      )}
    </div>
  );
}
