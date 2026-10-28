// Adapted from GlanceCode (https://github.com/sousyllc/glancecode), MIT License, Copyright (c) 2026 Sousy LLC. See LICENSE.
// Builds the app and packs app.json with dist/ into pane.ehpk for the Even Hub portal.
// Raise "version" in app.json before each upload: the portal does not offer phones an
// update for a version it already has.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sdkVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).dependencies['@evenrealities/even_hub_sdk'];
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });

run('pnpm', ['exec', 'vite', 'build']);
run('pnpm', ['exec', 'evenhub', 'pack', 'app.json', 'dist', '-o', 'pane.ehpk', '--sdk-ver', sdkVersion]);
console.log(`Packed ${root}pane.ehpk`);
