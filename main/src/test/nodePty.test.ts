import fs from 'fs';
import * as pty from '@lydell/node-pty';
import { describe, expect, it } from 'vitest';

const openFileCount = () => fs.readdirSync('/dev/fd').length;

async function runToExit(command: string): Promise<void> {
  const terminal = pty.spawn('/bin/sh', ['-c', command], { cols: 80, rows: 24 });
  terminal.onData(() => {});
  await new Promise<void>(resolve => terminal.onExit(() => resolve()));
}

// Every Pane terminal, agent tab and run command is a node-pty spawn. On macOS the
// kernel allows 511 pseudo-terminals (kern.tty.ptmx_max), so a terminal that keeps
// any descriptor after its process exits eventually stops new tabs from starting.
describe.skipIf(process.platform === 'win32')('node-pty', () => {
  it('gives back every file descriptor once a terminal process exits', async () => {
    await runToExit('true');
    const before = openFileCount();

    // node-pty reports the exit only after it closes its side of the terminal.
    for (let i = 0; i < 20; i++) await runToExit('echo done');

    expect(openFileCount() - before).toBeLessThan(5);
  });
});
