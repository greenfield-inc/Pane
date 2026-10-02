import { exec, execFile, ExecOptions, ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import { getShellPath } from './shellPath';
import { WSLContext, escapeForBash, getWSLExecArgs } from './wslUtils';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const nodeExecAsync = promisify(exec);
const nodeExecFileAsync = promisify(execFile);

function decodeStringCwd(cwd: string | URL): string | undefined {
  try {
    return decodeBoundary(cwd, boundary.string);
  } catch {
    return undefined;
  }
}

/**
 * Compute env vars that differ from the current process.env.
 * These need to be forwarded explicitly into WSL bash sessions
 * since wsl.exe does not automatically pass Windows env vars through.
 */
function getExtraEnvVars(mergedEnv?: Record<string, string | undefined>): Record<string, string> | undefined {
  if (!mergedEnv) return undefined;
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (key === 'PATH' || value === undefined) continue;
    if (process.env[key] !== value) {
      extra[key] = value;
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

interface ExtendedExecAsyncOptions extends ExecOptions {
  timeout?: number;
  silent?: boolean;
}

export interface ExecFileAsyncOptions extends ExecFileOptions {
  okExitCodes?: number[];
  silent?: boolean;
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ExecFileFailure extends Error {
  code?: number | string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

export class CommandExecutor {
  constructor(private readonly fileExecutor: typeof nodeExecFileAsync = nodeExecFileAsync) {}

  async execAsync(command: string, options?: ExtendedExecAsyncOptions, wslContext?: WSLContext | null): Promise<{ stdout: string; stderr: string }> {
    const cwd = options?.cwd || process.cwd();
    const shellPath = getShellPath();
    const silentMode = options?.silent === true;

    if (wslContext) {
      // Invoke wsl.exe directly via execFile — bypasses cmd.exe entirely
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { cwd: _cwd, silent: _silent, ...cleanOptions } = options || {};
      const wslCwd = decodeStringCwd(cwd);
      const extraEnv = getExtraEnvVars(cleanOptions?.env);
      const { file, args } = getWSLExecArgs(command, wslContext.distribution, wslCwd, extraEnv);

      if (!silentMode) {
        console.log(`[CommandExecutor] Executing async (WSL): ${file} ${args.join(' ')} in ${cwd}`);
      }
      const timeout = cleanOptions?.timeout ?? 60_000;
      const maxBuffer = cleanOptions?.maxBuffer || 10 * 1024 * 1024;
      const wslOptions: ExecFileOptions = {
        ...cleanOptions,
        timeout,
        maxBuffer,
        env: { ...process.env, ...cleanOptions?.env, PATH: shellPath },
      };

      try {
        const result = await nodeExecFileAsync(file, args, wslOptions);

        if (result.stdout && !silentMode) {
          const stdout = String(result.stdout);
          const lines = stdout.split('\n');
          const preview = lines[0].substring(0, 100) +
                          (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
          console.log(`[CommandExecutor] Async Success: ${preview}`);
        }

        return { stdout: String(result.stdout), stderr: String(result.stderr) };
      } catch (error: unknown) {
        if (!silentMode) {
          console.error(`[CommandExecutor] Async Failed (WSL): ${command}`);
          console.error(`[CommandExecutor] Async Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    }

    if (!silentMode) {
      console.log(`[CommandExecutor] Executing async: ${command} in ${cwd}`);
    }

    const timeout = options?.timeout ?? 60_000;
    const maxBuffer = options?.maxBuffer || 10 * 1024 * 1024;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { silent: _silent, ...cleanOptions } = options || {};

    const enhancedOptions: ExecOptions = {
      ...cleanOptions,
      timeout,
      maxBuffer,
      env: {
        ...process.env,
        ...cleanOptions?.env,
        PATH: shellPath
      }
    };

    try {
      const result = await nodeExecAsync(command, enhancedOptions);

      if (result.stdout && !silentMode) {
        const stdout = String(result.stdout);
        const lines = stdout.split('\n');
        const preview = lines[0].substring(0, 100) +
                        (lines.length > 1 ? ` ... (${lines.length} lines)` : '');
        console.log(`[CommandExecutor] Async Success: ${preview}`);
      }

      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error: unknown) {
      if (!silentMode) {
        console.error(`[CommandExecutor] Async Failed: ${command}`);
        console.error(`[CommandExecutor] Async Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  async execFileAsync(
    file: string,
    args: readonly string[],
    options?: ExecFileAsyncOptions,
    wslContext?: WSLContext | null,
  ): Promise<ExecFileResult> {
    const cwd = options?.cwd || process.cwd();
    const shellPath = getShellPath();
    const silentMode = options?.silent === true;
    const { okExitCodes = [], silent: _silent, ...cleanOptions } = options || {};
    void _silent;
    let executable = file;
    let executableArgs = [...args];
    let executionOptions: ExecFileOptions = {
      ...cleanOptions,
      cwd,
      timeout: cleanOptions.timeout || 60_000,
      maxBuffer: cleanOptions.maxBuffer || 10 * 1024 * 1024,
      env: { ...process.env, ...cleanOptions.env, PATH: shellPath },
    };

    if (wslContext) {
      const wslCwd = decodeStringCwd(cwd);
      const extraEnv = getExtraEnvVars(cleanOptions.env);
      const command = [file, ...args].map(escapeForBash).join(' ');
      const wrapped = getWSLExecArgs(command, wslContext.distribution, wslCwd, extraEnv);
      executable = wrapped.file;
      executableArgs = wrapped.args;
      executionOptions = { ...executionOptions, cwd: undefined };
    }

    if (!silentMode) console.log(`[CommandExecutor] Executing file: ${executable} ${executableArgs.join(' ')} in ${cwd}`);
    try {
      const result = await this.fileExecutor(executable, executableArgs, executionOptions);
      return { stdout: String(result.stdout), stderr: String(result.stderr), exitCode: 0 };
    } catch (cause: unknown) {
      // SAFETY: Node's execFile rejection contract supplies Error plus code/stdout/stderr.
      const error = cause as ExecFileFailure;
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw error;
      let numericCode: number | null = null;
      try { numericCode = decodeBoundary(error.code, boundary.number); } catch { numericCode = null; }
      if (numericCode !== null && okExitCodes.includes(numericCode)) {
        return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), exitCode: numericCode };
      }
      if (!silentMode) console.error(`[CommandExecutor] File execution failed: ${error.message}`);
      throw error;
    }
  }
}

// Export a singleton instance
export const commandExecutor = new CommandExecutor();
