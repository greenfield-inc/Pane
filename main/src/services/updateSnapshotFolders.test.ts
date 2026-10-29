import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PANE_STATE_FOLDERS, PANE_UNSNAPSHOTTED_FOLDERS } from '../../../packages/runpane/src/updateCapacity';

const repo = path.resolve(__dirname, '../../..');
/** Top-level files: the snapshot copies every top-level file, so these need no list. */
const TOP_LEVEL_FILES = new Set(['.running', 'attribution_ref']);
// Every way the code names a top-level entry of Pane data.
const PANE_DATA_ENTRY = /(?:getAppSubdirectory\(\s*|join\(\s*(?:getAppDirectory\(\)|appDirectory|this\.appDirectory|options\.appDirectory|paneDir|host\.paneDir|preflight\.paneDir)\s*,\s*)['"`]([^'"`$/\\]+)['"`]/g;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'dist', 'generated'].includes(entry.name) ? [] : sourceFiles(file);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [file] : [];
  });
}

describe('update recovery snapshot folders', () => {
  // A Pane state folder missing from PANE_STATE_FOLDERS would be left out of
  // the snapshot as "unknown"; decide which list a new folder belongs on.
  it('classifies every top-level folder Pane writes in its data folder', () => {
    const known = new Set<string>([...PANE_STATE_FOLDERS, ...PANE_UNSNAPSHOTTED_FOLDERS]);
    const unclassified = new Map<string, string>();
    for (const file of [...sourceFiles(path.join(repo, 'main', 'src')), ...sourceFiles(path.join(repo, 'packages', 'runpane', 'src'))]) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(PANE_DATA_ENTRY)) {
        const name = match[1];
        const isFile = TOP_LEVEL_FILES.has(name) || /^[^.].*\.[a-z]+$/i.test(name);
        if (!isFile && !known.has(name)) unclassified.set(name, path.relative(repo, file));
      }
    }
    expect(Object.fromEntries(unclassified)).toEqual({});
  });

  it('puts no folder on both lists', () => {
    const unsnapshotted = new Set<string>(PANE_UNSNAPSHOTTED_FOLDERS);
    expect(PANE_STATE_FOLDERS.filter(name => unsnapshotted.has(name))).toEqual([]);
  });
});
