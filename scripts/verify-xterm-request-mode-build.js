#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const defaultDistDir = path.basename(cwd) === 'frontend'
  ? path.join(cwd, 'dist')
  : path.join(cwd, 'frontend', 'dist');
const distDir = path.resolve(process.argv[2] || defaultDistDir);
const assetsDir = path.join(distDir, 'assets');

if (!fs.existsSync(assetsDir)) {
  console.error(`[verify-xterm] Missing assets directory: ${assetsDir}`);
  process.exit(1);
}

const brokenRequestModePattern = /requestMode\([^)]*\)\{[^}]*void 0\|\|\([A-Za-z_$][\w$]*=\{\}\)/;

// The bundler names xterm's shared chunk after one of the modules it groups
// (currently addon-fit), so find it by the enum inside requestMode instead.
const xtermChunks = [];
for (const chunk of fs.readdirSync(assetsDir).filter((file) => file.endsWith('.js'))) {
  const filePath = path.join(assetsDir, chunk);
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.includes('requestMode(') || !content.includes('NOT_RECOGNIZED')) continue;
  xtermChunks.push(chunk);

  if (brokenRequestModePattern.test(content)) {
    console.error(`[verify-xterm] Broken xterm requestMode output found in ${filePath}`);
    console.error('[verify-xterm] This build will crash when TUIs emit DECRQM mode requests.');
    process.exit(1);
  }
}

if (xtermChunks.length === 0) {
  console.error(`[verify-xterm] Could not find xterm's requestMode in any chunk in ${assetsDir}`);
  process.exit(1);
}

console.log(`[verify-xterm] requestMode build output OK (${xtermChunks.join(', ')})`);
