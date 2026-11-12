// Builds the ChatGPT agents panel (panel/) into dist/panel.html: one file with the script and
// styles inlined, because the host's CSP blocks external scripts and stylesheets. esbuild keeps
// the build working on Node 20, which the runpane wrapper supports.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const packageDir = path.resolve(__dirname, '..');
const panelDir = path.join(packageDir, 'panel');

const result = esbuild.buildSync({
  entryPoints: [path.join(panelDir, 'main.tsx')],
  outdir: path.join(packageDir, 'dist', 'panel-build'),
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'warning',
});
const script = result.outputFiles.find((file) => file.path.endsWith('.js'));
const styles = result.outputFiles.filter((file) => file.path.endsWith('.css'));
if (!script || result.outputFiles.length !== 1 + styles.length) {
  throw new Error(`The panel must build to one script and its CSS, got: ${result.outputFiles.map((file) => path.basename(file.path)).join(', ')}`);
}
const css = styles.map((file) => file.text).join('\n');
const html = fs.readFileSync(path.join(panelDir, 'index.html'), 'utf8')
  .replace('<!-- PANEL_STYLE -->', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
  .replace('<!-- PANEL_SCRIPT -->', () => `<script>${script.text.replace(/<\/script/gi, '<\\/script')}</script>`);
fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
fs.writeFileSync(path.join(packageDir, 'dist', 'panel.html'), html);
