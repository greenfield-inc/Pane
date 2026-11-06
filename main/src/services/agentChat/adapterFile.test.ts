import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { adapterFileForPlainNode } from './adapterSetup';

const cleanup: string[] = [];
afterEach(() => { for (const directory of cleanup.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function folder() { const directory = mkdtempSync(path.join(tmpdir(), 'pane-adapter-')); cleanup.push(directory); return directory; }

describe('the adapter file Agent Farm runs with plain Node', () => {
  it('is the entry itself outside app.asar', () => {
    const data = folder();
    expect(adapterFileForPlainNode('/repo/node_modules/adapter/dist/index.js', data)).toBe('/repo/node_modules/adapter/dist/index.js');
  });

  it('is a launcher outside app.asar when the entry is inside it, carrying the conversation over stdio and the exit code', () => {
    const root = folder();
    const entry = path.join(root, 'app.asar', 'node_modules', 'claude-agent-acp', 'dist', 'index.js');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, "process.stdin.on('data', chunk => process.stdout.write(`${process.env.ELECTRON_RUN_AS_NODE}:${chunk}`)); process.stdin.on('end', () => process.exit(7));");
    const file = adapterFileForPlainNode(entry, path.join(root, 'data'), process.execPath);
    expect(file).not.toContain('.asar');
    const run = spawnSync(process.execPath, [file], { input: 'hello', encoding: 'utf8' });
    expect(run.stdout).toBe('1:hello');
    expect(run.status).toBe(7);
  });

  it('keeps up when Pane moves or updates', () => {
    const data = folder();
    const first = adapterFileForPlainNode('/old/app.asar/node_modules/adapter/dist/index.js', data, '/old/Pane');
    const second = adapterFileForPlainNode('/new/app.asar/node_modules/adapter/dist/index.js', data, '/new/Pane');
    expect(second).toBe(first);
    const run = spawnSync('grep', ['-c', '/new/Pane', second], { encoding: 'utf8' });
    expect(run.stdout.trim()).toBe('1');
  });
});
