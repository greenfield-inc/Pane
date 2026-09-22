import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as monaco from 'monaco-editor';
import { FileEditorView } from '../../frontend/src/components/panels/editor/FileEditorView';
import { MonacoErrorBoundary } from '../../frontend/src/components/MonacoErrorBoundary';
import { ThemeProvider } from '../../frontend/src/contexts/ThemeProvider';
import type { EditorPanelState } from '../../shared/types/panels';
import '../../frontend/src/index.css';

Object.defineProperty(window, '__editorDiagnostics', {
  value: async () => {
    const model = monaco.editor.getModels()[0];
    if (!model) throw new Error('Missing editor model');
    const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
    const worker = await getWorker(model.uri);
    const diagnostics = await worker.getSemanticDiagnostics(model.uri.toString());
    return diagnostics.map(diagnostic => diagnostic.code);
  },
});
Object.defineProperty(window, '__editorModelCount', { get: () => monaco.editor.getModels().length });

function BrokenEditor(): never {
  throw new Error('Editor fixture failure');
}

function EditorFixture() {
  const [filePath, setFilePath] = useState('alpha.ts');
  const [mounted, setMounted] = useState(true);
  const [broken, setBroken] = useState(false);
  const [states, setStates] = useState<Record<string, EditorPanelState>>({
    'alpha.ts': { filePath: 'alpha.ts', cursorPosition: { line: 2, column: 1 } },
  });

  return (
    <ThemeProvider>
      <nav>
        {['alpha.ts', 'beta.json', 'style.css', 'index.html', 'notes.md'].map(path => (
          <button key={path} type="button" onClick={() => setFilePath(path)}>Open {path}</button>
        ))}
        <button type="button" onClick={() => setMounted(value => !value)}>Toggle editor</button>
        <button type="button" onClick={() => setBroken(true)}>Break editor</button>
      </nav>
      {broken ? (
        <MonacoErrorBoundary><BrokenEditor /></MonacoErrorBoundary>
      ) : mounted ? (
        <div style={{ height: 600 }}>
          <FileEditorView
            sessionId="editor-fixture"
            filePath={filePath}
            initialState={states[filePath]}
            onStateChange={next => setStates(previous => ({ ...previous, [filePath]: { ...previous[filePath], ...next } }))}
          />
        </div>
      ) : null}
    </ThemeProvider>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing fixture root');
createRoot(container).render(<EditorFixture />);
