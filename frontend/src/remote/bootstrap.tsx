import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import '@xterm/xterm/css/xterm.css';
import { THEME_CLASSES } from '../contexts/themeContextValue';
import { RemotePwaApp } from './RemotePwaApp';
import { startCaretRest } from '../services/caretRest';

// The PWA has no theme switcher; it is fixed to light-rounded, which is what
// `remote.html` declares and what its `theme-color` meta is set to. Taken from
// `THEME_CLASSES` rather than written out, because every theme in this repo is
// a base plus a delta — `light-rounded` is nine declarations that assume the
// hundred-odd in `light` are already there — and naming only the delta is how
// this surface ended up painting light borders onto the dark default palette.
const REMOTE_THEME_CLASSES = THEME_CLASSES['light-rounded'];

let mounted = false;

export function mountRemoteRenderer(): void {
  if (mounted) return;
  mounted = true;
  startCaretRest();

  document.documentElement.classList.add(...REMOTE_THEME_CLASSES);
  document.body.classList.add(...REMOTE_THEME_CLASSES);

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <RemotePwaApp />
    </React.StrictMode>,
  );
}
