import { commandExecutor } from './commandExecutor';
import type { ExecFileAsyncOptions, ExecFileResult } from './commandExecutor';
import { getWSLContextFromProject, type WSLContext } from './wslUtils';

export interface CommandRunOptions {
  timeout?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
  silent?: boolean;
}

export class CommandRunner {
  public readonly wslContext: WSLContext | null;

  constructor(project: { wsl_enabled?: boolean; wsl_distribution?: string | null; path: string }) {
    this.wslContext = getWSLContextFromProject(project);
  }

  /** Execute command asynchronously, wrapping for WSL if needed */
  async execAsync(command: string, cwd: string, options?: CommandRunOptions): Promise<{ stdout: string; stderr: string }> {
    return commandExecutor.execAsync(command, {
      cwd,
      ...options,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
    }, this.wslContext);
  }

  async execFile(file: string, args: readonly string[], cwd: string, options?: ExecFileAsyncOptions): Promise<ExecFileResult> {
    return commandExecutor.execFileAsync(file, args, {
      ...options,
      cwd,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
    }, this.wslContext);
  }
}
