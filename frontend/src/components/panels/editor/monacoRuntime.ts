import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// Vite bundles the installed, lockfile-verified runtime and workers. Relative
// worker URLs also work when Electron loads the packaged app with file://.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json': return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less': return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor': return new HtmlWorker();
      case 'typescript':
      case 'javascript': return new TypeScriptWorker();
      default: return new EditorWorker();
    }
  },
};
loader.config({ monaco });

export default Editor;
