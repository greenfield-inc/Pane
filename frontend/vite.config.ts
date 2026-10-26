import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { cpSync } from 'node:fs';
import { createHash } from 'node:crypto';

// @monaco-editor/loader's default: the editor loads this exact build from jsDelivr.
const MONACO_CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/';
// The default PostHog host (frontend/src/services/posthog.ts).
const ANALYTICS_HOST = 'https://runpane.com';

/**
 * The main window's Content-Security-Policy. It renders untrusted Markdown, Mermaid and
 * agent output next to IPC that can run commands, so scripts come only from the bundle,
 * the two inline theme bootstraps in index.html (by hash) and the pinned Monaco build.
 * frame-ancestors is not set: a <meta> policy cannot carry it, and the window is
 * top-level. Dev adds 'unsafe-inline' for Vite's React refresh preamble and HMR's socket.
 */
function rendererCsp(html: string, dev: boolean): string {
  const inlineScriptHashes = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g),
    ([, body]) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // 'wasm-unsafe-eval' lets xterm's image addon compile its WebAssembly decoder; it does not allow JS eval.
    'script-src': ["'self'", "'wasm-unsafe-eval'", ...(dev ? ["'unsafe-inline'"] : inlineScriptHashes), MONACO_CDN],
    // Monaco, xterm, mermaid and Excalidraw inject <style> elements and style attributes.
    'style-src': ["'self'", "'unsafe-inline'", MONACO_CDN],
    // Markdown previews show remote images; file previews are served over pane-media:.
    'img-src': ["'self'", 'data:', 'blob:', 'https:', 'pane-media:'],
    'font-src': ["'self'", 'data:', 'pane-media:', MONACO_CDN],
    'media-src': ["'self'", 'blob:', 'pane-media:'],
    'connect-src': ["'self'", 'pane-media:', ANALYTICS_HOST, ...(dev ? ['ws://localhost:*'] : [])],
    'worker-src': ["'self'", 'blob:'],
    // PDF previews render through <object data="pane-media://...">, which Chromium's viewer frames.
    'object-src': ['pane-media:'],
    'frame-src': ["'self'", 'pane-media:'],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  };
  return Object.entries(directives).map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

export default defineConfig(({ command }) => ({
  plugins: [react(), {
    name: 'pane-renderer-csp',
    transformIndexHtml: {
      // After Vite's own transforms, so the hashed inline scripts are final.
      order: 'post',
      handler(html, ctx) {
        if (!ctx.filename.endsWith('index.html')) return html;
        const policy = rendererCsp(html, command === 'serve');
        return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  }, {
    name: 'pane-notes-drawing-fonts',
    buildStart() {
      cpSync(resolve(import.meta.dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts'),
        resolve(import.meta.dirname, 'public/excalidraw-assets/fonts'), { recursive: true });
    },
  }],
  define: {
    __PANE_REACT_SCAN_ENABLED__: JSON.stringify(
      command === 'serve' && process.env.PANE_REACT_SCAN === '1'
    )
  },
  server: {
    port: parseInt(process.env.VITE_PORT || process.env.PORT || '4521', 10),
    strictPort: true
  },
  base: './',
  build: {
    target: 'es2021',
    // Ensure assets are copied and paths are relative
    assetsDir: 'assets',
    // Copy public files to dist
    copyPublicDir: true,
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        remote: resolve(import.meta.dirname, 'remote.html'),
      },
    },
  }
}));
