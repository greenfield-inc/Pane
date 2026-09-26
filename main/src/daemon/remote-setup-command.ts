import { execFile } from 'child_process';

interface RemoteSetupCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export type RemoteSetupCommandRunner = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<RemoteSetupCommandResult>;

/** Host setup commands use argv and never block the Electron event loop. */
export const runRemoteSetupCommand: RemoteSetupCommandRunner = (command, args, options = {}) => new Promise(resolve => {
  execFile(command, args, {
    encoding: 'utf8', timeout: options.timeoutMs ?? 30_000, env: options.env ?? process.env,
  }, (error, stdout, stderr) => {
    resolve({ ok: !error, stdout, stderr: stderr || error?.message || '' });
  });
});
