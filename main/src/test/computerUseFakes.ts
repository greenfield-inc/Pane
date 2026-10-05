import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import type { ComputerUseEngine, EngineResult } from '../services/computerUse/engine';

export const PIXEL = { mime: 'image/png', base64: 'iVBORw0KGgo=' };

/** The daemon forks the compiled script child; build the same file from source. Returns its path and a cleanup. */
export function buildScriptHostChild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-host-'));
  const entry = path.join(dir, 'scriptHostChild.js');
  buildSync({
    entryPoints: [path.join(__dirname, '../services/computerUse/scriptHostChild.ts')],
    outfile: entry,
    platform: 'node',
    format: 'cjs',
    bundle: true,
  });
  return { entry, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * An engine that records `start`/`end` of each call; each call takes `delayMs`. `screenshot` returns
 * PIXEL, and `list_apps` lists TextEdit as pid 7.
 */
export function fakeEngine(delayMs = 0) {
  const log: string[] = [];
  let stops = 0;
  const engine: ComputerUseEngine = {
    id: 'cua-driver',
    status: async () => ({ installed: true, permissions: {}, desktopSession: true }),
    async call(tool, args): Promise<EngineResult> {
      const label = `${tool}:${String(args.text ?? args.pid ?? '')}`;
      log.push(`start ${label}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      log.push(`end ${label}`);
      if (tool === 'screenshot') return { ok: true, images: [PIXEL] };
      if (tool === 'list_apps') return { ok: true, data: { apps: [{ pid: 7, name: 'TextEdit' }] } };
      return { ok: true, data: { tool, args } };
    },
    async stop() { stops += 1; },
  };
  return { engine, log, stops: () => stops };
}
