import { describe, expect, it } from 'vitest';
import { spawnHelperProcess, type HelperProcess, type WindowsKeepAwakeMode } from './windowsKeepAwakeHelper';

// Runs the real PowerShell helper, so it needs Windows. CI runs on Ubuntu and
// skips it; run it locally on Windows when the helper script changes.
describe.skipIf(process.platform !== 'win32')('Windows keep-awake helper (real powershell.exe)', () => {
  function waitForLine(child: HelperProcess, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`no line within ${timeoutMs} ms; output: ${output}`)), timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const newline = output.indexOf('\n');
        if (newline !== -1) {
          clearTimeout(timer);
          resolve(output.slice(0, newline).trim());
        }
      });
    });
  }

  function waitForExit(child: HelperProcess, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`still running ${timeoutMs} ms after stdin closed`)), timeoutMs);
      child.on('exit', (code: number | null) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  it.each<WindowsKeepAwakeMode>(['system-required', 'press-f15'])(
    'reports ready in %s mode and exits within 5 s of its stdin closing',
    async mode => {
      const child = spawnHelperProcess(mode);
      try {
        expect(await waitForLine(child, 20_000)).toBe('ready');
        if (mode === 'press-f15') child.stdin?.write('f15\n');
        const exited = waitForExit(child, 5_000);
        child.stdin?.end();
        expect(await exited).toBe(0);
      } finally {
        child.kill();
      }
    },
    30_000,
  );
});
