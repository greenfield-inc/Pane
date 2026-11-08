import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attachDebugger, retainedDebuggerCount, type DebuggableContents } from './debuggerLifetime';

function contents() {
  let attached = false;
  let destroyed = false;
  let onDestroyed: (() => void) | undefined;
  const page: DebuggableContents = {
    isDestroyed: () => destroyed,
    once: (_event, listener) => { onDestroyed = listener; },
    debugger: {
      attach: () => { attached = true; },
      isAttached: () => attached,
      detach: () => { attached = false; },
    },
  };
  const destroy = () => { destroyed = true; onDestroyed?.(); };
  return { page, destroy, isAttached: () => attached };
}

describe('attachDebugger (D-216)', () => {
  it('holds the debugger while its page lives and detaches it when the page is destroyed', () => {
    const { page, destroy, isAttached } = contents();
    const before = retainedDebuggerCount();
    attachDebugger(page);
    attachDebugger(page);
    expect(isAttached()).toBe(true);
    expect(retainedDebuggerCount()).toBe(before + 1);
    destroy();
    expect(isAttached()).toBe(false);
    expect(retainedDebuggerCount()).toBe(before);
  });
});

const MAIN_SRC = join(__dirname, '..');
const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return sourceFiles(path);
  return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
});

describe('debugger attach guard (D-216)', () => {
  it('finds no debugger attach in main outside attachDebugger, which detaches it before its page goes', () => {
    const offenders = sourceFiles(MAIN_SRC)
      .filter(path => relative(MAIN_SRC, path) !== join('services', 'debuggerLifetime.ts'))
      .filter(path => /\.debugger\s*\.\s*attach\s*\(|\bdebugger\s*\[\s*['"]attach['"]\s*\]/.test(readFileSync(path, 'utf8')))
      .map(path => relative(MAIN_SRC, path));
    expect(offenders, 'Attach a debugger with attachDebugger (services/debuggerLifetime.ts) so it is detached before its page is destroyed (electron/electron#53376).').toEqual([]);
  });
});
