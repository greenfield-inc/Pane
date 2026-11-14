import { spawn, type SpawnOptions } from 'node:child_process';

export interface ChildEnd {
  status: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Runs a program with stdio passed through and this CLI's signals forwarded to it. Resolves with how
 * it ended, or with the spawn error's code when it could not start.
 */
export async function runForwardingSignals(file: string, args: string[], options: SpawnOptions = {}): Promise<ChildEnd | { error: string }> {
  // From a terminal, Ctrl-C and Ctrl-\ reach the child through the process group it shares with
  // this CLI, so forwarding them would deliver them twice. Without a terminal the child gets its
  // own group and every signal is forwarded once.
  const ownGroup = process.platform !== 'win32' && !process.stdin.isTTY;
  const child = spawn(file, args, { ...options, stdio: 'inherit', detached: ownGroup });
  const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
  const interrupt = (signal: NodeJS.Signals) => () => { if (ownGroup) forward(signal); };
  const handlers: Array<[NodeJS.Signals, () => void]> = [
    ['SIGINT', interrupt('SIGINT')],
    ['SIGQUIT', interrupt('SIGQUIT')],
    ['SIGTERM', () => forward('SIGTERM')],
    ['SIGHUP', () => forward('SIGHUP')],
  ];
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const result = await new Promise<ChildEnd | { error: string }>((resolve) => {
    child.once('error', (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? 'unknown error' }));
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  for (const [signal, handler] of handlers) process.off(signal, handler);
  return result;
}
