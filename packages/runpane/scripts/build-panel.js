// Builds the ChatGPT agents panel (panel/) into dist/panel.html: one file with the script and
// styles inlined, because the host's CSP blocks external scripts and stylesheets.
const fs = require('fs');
const path = require('path');

const packageDir = path.resolve(__dirname, '..');
const panelDir = path.join(packageDir, 'panel');

async function main() {
  const { build } = await import('vite');
  const output = await build({
    configFile: false,
    root: panelDir,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"', __PANEL_DIRECTION__: JSON.stringify(process.env.PANEL_DIRECTION ?? 'sidebar') },
    build: {
      write: false,
      target: 'es2022',
      minify: true,
      cssCodeSplit: false,
      lib: { entry: path.join(panelDir, 'main.tsx'), formats: ['iife'], name: 'PaneAgentsPanel', fileName: () => 'panel.js', cssFileName: 'panel' },
      rolldownOptions: { output: { codeSplitting: false } },
    },
  });
  const files = (Array.isArray(output) ? output : [output]).flatMap((result) => result.output);
  const scripts = files.filter((file) => file.type === 'chunk');
  const styles = files.filter((file) => file.type === 'asset' && file.fileName.endsWith('.css'));
  if (scripts.length !== 1 || files.length !== scripts.length + styles.length) {
    throw new Error(`The panel must build to one script and its CSS, got: ${files.map((file) => file.fileName).join(', ')}`);
  }
  const css = styles.map((file) => String(file.source)).join('\n');
  const html = fs.readFileSync(path.join(panelDir, 'index.html'), 'utf8')
    .replace('<!-- PANEL_STYLE -->', () => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace('<!-- PANEL_SCRIPT -->', () => `<script>${scripts[0].code.replace(/<\/script/gi, '<\\/script')}</script>`);
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'dist', process.env.PANEL_OUT ?? 'panel.html'), html);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
