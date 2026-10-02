// Writes dist/docs-index.json: Pane's docs/*.md for `runpane docs search|read`, so the
// search works offline from the npm package and the copy bundled in the Pane app.
const fs = require('fs');
const path = require('path');

const docsDir = path.resolve(__dirname, '..', '..', '..', 'docs');
const outFile = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'dist', 'docs-index.json');

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

const docs = markdownFiles(docsDir).sort().map((file) => {
  const text = fs.readFileSync(file, 'utf8');
  const heading = /^#\s+(.+)$/m.exec(text);
  return {
    path: path.relative(path.dirname(docsDir), file).split(path.sep).join('/'),
    title: heading ? heading[1].trim() : path.basename(file, '.md'),
    text,
  };
});
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(docs)}\n`);
