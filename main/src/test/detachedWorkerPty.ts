import * as pty from '@lydell/node-pty';

export interface DetachedWorkerPty {
  /** The PTY's shell: what Pane records as a terminal's pid. */
  shellPid: number;
  /** A worker that double-forked out of the shell's tree into its own process group. */
  workerPid: number;
  close(): void;
}

/**
 * A real PTY whose shell starts a worker the way prompt helpers (gitstatusd)
 * and orphaned MCP servers end up: its parent exits, init adopts it, and it
 * sits in its own process group, yet it keeps the PTY as its controlling
 * terminal. POSIX only.
 */
export async function spawnDetachedWorkerPty(): Promise<DetachedWorkerPty> {
  const shell = pty.spawn('/bin/sh', ['-c', `( perl -e 'setpgrp(0,0); print "worker=$$\\n"; exec "sleep", 600' & ) ; sleep 600`], { cols: 80, rows: 24 });
  const workerPid = await new Promise<number>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`the detached worker never reported its pid; output: ${output}`)), 10_000);
    shell.onData(data => {
      output += data;
      const match = /worker=(\d+)/u.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return {
    shellPid: shell.pid,
    workerPid,
    close: () => shell.kill(),
  };
}
