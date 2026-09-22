# Editor runtime and lifecycle

The file editor imports `monacoRuntime.ts`, which configures `@monaco-editor/react`
with the installed `monaco-editor` runtime before mounting an editor. Vite packages
the editor, JSON, CSS, HTML, and TypeScript workers as local assets. The wrapper
must never fall back to its default CDN loader: runtime code follows the same
lockfile, release-age, and dependency review rules as the rest of the app.
App typography uses the existing local font fallback stack instead of a remote
Google Fonts stylesheet, so an unavailable font server cannot abort Vite's
production stylesheet preload and prevent startup.

Each session/file owns a mounted React wrapper. Changing the file remounts that
wrapper, which disposes its own model; parent components must not dispose the
model through a mutable editor ref. The tab reducer owns text and autosave state,
and the persisted panel state restores cursor and scroll positions. Position
subscriptions and pending saves end when their editor is disposed.

Rendering errors show an explicit retry action. One retry is allowed for that
file's boundary; repeated failure remains visible rather than scheduling an
automatic remount loop. The tab retains its current text during recovery and logs
error details for diagnosis.

`tests/monaco-editor.spec.ts` mounts the actual file editor, blocks external
requests, verifies language workers start, edits across file changes and remounts,
and checks bounded error recovery. It runs in the maintained CI smoke suite.
CI also builds the frontend and runs `playwright.packaged.config.ts`: an isolated
Electron window loads the production `file://` entry with external requests
blocked and verifies local workers, TypeScript diagnostics, and saving. The
fixture uses sandboxed renderer settings and mocked file IPC without starting
Pane's database or daemon.
