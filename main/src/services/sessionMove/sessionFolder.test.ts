import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isVerbatimSessionFile, listSessionFolder } from './sessionFolder';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });

// T-110 (D-3): Agent Farm's snapshots travel with the Session; its rebuilt launch bundles don't.
describe('what of a Session folder travels', () => {
  it('carries Agent Farm\'s snapshots and leaves its generated bundles and half-built snapshots', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-session-folder-'));
    folders.push(root);
    for (const relative of ['notes.md', '.agent-farm/snapshots/d1/plugins/team/plugin.yaml', '.agent-farm/snapshots/d1/checksums.json', '.agent-farm/snapshots/.building-x/plugin.yaml', '.agent-farm/generated/bundle/manifest.json']) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), 'x');
    }
    expect(listSessionFolder(root)).toEqual(['.agent-farm/snapshots/d1/checksums.json', '.agent-farm/snapshots/d1/plugins/team/plugin.yaml', 'notes.md']);
  });

  it('carries snapshot files byte for byte, and other text with its paths rewritten', () => {
    expect(isVerbatimSessionFile('.agent-farm/snapshots/d1/plugins/team/agents/lead.md')).toBe(true);
    expect(isVerbatimSessionFile('plans/plan.md')).toBe(false);
  });
});
