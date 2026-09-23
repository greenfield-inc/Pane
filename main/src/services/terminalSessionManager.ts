import { EventEmitter } from 'events';
import * as pty from '@lydell/node-pty';
import { getPtyHostRuntime, getRuntimeConfigManager, type PtyHandleLike, type PtyHostRuntime } from '../core/runtime';
import { getShellPath } from '../utils/shellPath';
import { ShellDetector } from '../utils/shellDetector';
import * as os from 'os';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { getGitAttributionEnv } from '../utils/attribution';
import { inheritedProcessEnv } from '../utils/inheritedProcessEnv';

/**
 * IPty-compatible shim over a ptyHost `PtyHandle`.
 *
 * Mirrors `PtyHandleShim` in `terminalPanelManager.ts`. Kept file-local
 * because the other shim is not exported; a tiny amount of duplication is
 * acceptable to keep each manager's surface decoupled.
 *
 * Critical: `pid` is cached from the spawn response so synchronous `.pid`
 * reads in `killProcessTree` (lines ~203-311) and the `session.pty.pid`
 * read at `:109` keep working after we route through the async RPC seam.
 */
class TerminalSessionPtyShim implements pty.IPty {
  readonly pid: number;
  cols: number;
  rows: number;
  readonly process = 'ptyHost';
  handleFlowControl = false;
  readonly ptyId: string;
  private readonly handle: PtyHandleLike;

  constructor(handle: PtyHandleLike, cols: number, rows: number) {
    this.handle = handle;
    this.ptyId = handle.id;
    this.pid = handle.pid;
    this.cols = cols;
    this.rows = rows;
  }

  readonly onData = (listener: (data: string) => void): pty.IDisposable => {
    return this.handle.onData(listener);
  };

  readonly onExit = (
    listener: (e: { exitCode: number; signal?: number }) => void,
  ): pty.IDisposable => {
    return this.handle.onExit((exitCode, signal) => {
      listener({
        exitCode: exitCode ?? 0,
        signal: signal === null ? undefined : signal,
      });
    });
  };

  resize(columns: number, rows: number): void {
    this.cols = columns;
    this.rows = rows;
    this.handle.resize(columns, rows).catch((err: Error) => {
      console.warn('[ptyHost] terminal-session resize failed', err);
    });
  }

  clear(): void {
    // No-op; ptyHost does not expose a clear RPC.
  }

  write(data: string | Buffer): void {
    const str = Buffer.isBuffer(data) ? data.toString() : data;
    this.handle.write(str).catch((err: Error) => {
      console.warn('[ptyHost] terminal-session write failed', err);
    });
  }

  kill(signal?: string): void {
    // SAFETY: node-pty declares this shim method as string, while callers pass
    // Node signal names and the host handle accepts that same finite set.
    this.handle.kill(signal as NodeJS.Signals | undefined).catch((err: Error) => {
      console.warn('[ptyHost] terminal-session kill failed', err);
    });
  }

  pause(): void {
    this.handle.pause().catch((err: Error) => {
      console.warn('[ptyHost] terminal-session pause failed', err);
    });
  }

  resume(): void {
    this.handle.resume().catch((err: Error) => {
      console.warn('[ptyHost] terminal-session resume failed', err);
    });
  }
}

interface TerminalSession {
  pty: pty.IPty;
  /** Host-allocated PTY id when routed through ptyHost; undefined on legacy path. */
  ptyId?: string;
  /** True when `pty` is a `TerminalSessionPtyShim` wrapping a ptyHost handle. */
  isPtyHost: boolean;
  sessionId: string;
  cwd: string;
}

export class TerminalSessionManager extends EventEmitter {
  private terminalSessions: Map<string, TerminalSession> = new Map();
  
  constructor() {
    super();
    // Increase max listeners to prevent warnings when many components listen to events
    this.setMaxListeners(50);
  }

  async createTerminalSession(sessionId: string, worktreePath: string): Promise<void> {
    // Check if session already exists
    if (this.terminalSessions.has(sessionId)) {
      return;
    }

    // For Linux, use the current PATH to avoid slow shell detection
    const isLinux = process.platform === 'linux';
    const shellPath = isLinux ? (process.env.PATH || '') : getShellPath();
    
    // Get the user's default shell
    const shellInfo = ShellDetector.getDefaultShell();
    console.log(`Using shell: ${shellInfo.path} (${shellInfo.name})`);
    
    // Build spawn env once so both paths see identical values.
    const rawEnv = {
      ...inheritedProcessEnv(),
      ...getGitAttributionEnv(getRuntimeConfigManager().getConfig()),
      PATH: shellPath,
      WORKTREE_PATH: worktreePath,
      TERM: 'xterm-256color',      // Ensure TERM is set for color support
      COLORTERM: 'truecolor',      // Enable 24-bit color
      LANG: process.env.LANG || 'en_US.UTF-8',  // Set locale for proper character handling
    } satisfies NodeJS.ProcessEnv;

    const spawnCols = 80;
    const spawnRows = 24;
    const shellArgs = shellInfo.args || [];

    // When the `usePtyHost` setting is on (with a live supervisor) the spawn
    // is routed through the ptyHost `UtilityProcess`; otherwise fall back to
    // the legacy in-main `pty.spawn`. Under setting-off or when the
    // supervisor is unavailable, behavior is byte-identical.
    const runtimeConfigManager = getRuntimeConfigManager();
    const useFlag = runtimeConfigManager.getUsePtyHost();
    let supervisor: PtyHostRuntime | null = null;
    if (useFlag) {
      supervisor = getPtyHostRuntime();
      if (!supervisor) {
        console.warn('[ptyHost] supervisor unavailable, falling back to legacy pty.spawn for terminal-session');
      }
    }
    const usePtyHost = !!supervisor;

    let ptyProcess: pty.IPty;
    let ptyHostId: string | undefined;

    if (usePtyHost && supervisor) {
      // RPC DTO requires `Record<string, string>`; drop undefined keys.
      const envStr: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawEnv)) {
        if (value !== undefined) {
          envStr[key] = value;
        }
      }
      const spawned = await supervisor.spawn({
        shell: shellInfo.path,
        args: shellArgs,
        cwd: worktreePath,
        cols: spawnCols,
        rows: spawnRows,
        env: envStr,
        name: 'xterm-256color',
      });
      const handle = supervisor.getHandle(spawned.ptyId);
      if (!handle) {
        throw new Error(`[ptyHost] supervisor returned ptyId=${spawned.ptyId} but getHandle() was undefined`);
      }
      ptyProcess = new TerminalSessionPtyShim(handle, spawnCols, spawnRows);
      ptyHostId = spawned.ptyId;
    } else {
      // Legacy path: direct in-main pty.spawn. Unchanged behavior.
      ptyProcess = pty.spawn(shellInfo.path, shellArgs, {
        name: 'xterm-256color',
        cwd: worktreePath,
        cols: spawnCols,
        rows: spawnRows,
        env: Object.fromEntries(Object.entries(rawEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      });
    }

    // Store the session. Pid is already cached on the shim for the ptyHost path
    // so `session.pty.pid` reads inside `closeTerminalSession` stay synchronous.
    this.terminalSessions.set(sessionId, {
      pty: ptyProcess,
      ptyId: ptyHostId,
      isPtyHost: usePtyHost,
      sessionId,
      cwd: worktreePath,
    });

    // Handle data from the PTY
    ptyProcess.onData((data: string) => {
      this.emit('terminal-output', { sessionId, data, type: 'stdout' });
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      console.log(`Terminal session ${sessionId} exited with code ${exitCode}, signal ${signal}`);
      this.terminalSessions.delete(sessionId);
    });

    // Don't send any initial input - let the user interact with the terminal
    // This prevents unnecessary terminal output and activity indicators
  }

  sendCommand(sessionId: string, command: string): void {
    const session = this.terminalSessions.get(sessionId);
    if (!session) {
      throw new Error('Terminal session not found');
    }

    // Send the command to the PTY
    session.pty.write(command + '\r');
  }

  sendInput(sessionId: string, data: string): void {
    const session = this.terminalSessions.get(sessionId);
    if (!session) {
      throw new Error('Terminal session not found');
    }

    // Send raw input directly to the PTY without modification
    session.pty.write(data);
  }

  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    const session = this.terminalSessions.get(sessionId);
    if (session) {
      session.pty.resize(cols, rows);
    }
  }

  async closeTerminalSession(sessionId: string): Promise<void> {
    const session = this.terminalSessions.get(sessionId);
    if (session) {
      try {
        const pid = session.pty.pid;
        
        // Kill the process tree to ensure all child processes are terminated
        if (pid) {
          const success = await this.killProcessTree(pid);
          if (!success) {
            // Emit warning about zombie processes
            this.emit('zombie-processes-detected', {
              sessionId,
              message: `Warning: Some child processes could not be terminated. Check system process list.`
            });
          }
        }
        
        // Also try to kill via pty interface as fallback
        try {
          session.pty.kill();
        } catch {
          // PTY might already be dead
        }
      } catch (error) {
        console.warn(`Error killing terminal session ${sessionId}:`, error);
      }
      this.terminalSessions.delete(sessionId);
    }
  }

  hasSession(sessionId: string): boolean {
    return this.terminalSessions.has(sessionId);
  }

  async cleanup(): Promise<void> {
    // Close all terminal sessions
    const closePromises = [];
    for (const sessionId of this.terminalSessions.keys()) {
      closePromises.push(this.closeTerminalSession(sessionId));
    }
    await Promise.all(closePromises);
  }

  /**
   * Get all descendant PIDs of a parent process recursively
   * This is critical for ensuring all child processes are killed
   */
  private getAllDescendantPids(parentPid: number): number[] {
    const descendants: number[] = [];
    const platform = os.platform();
    
    try {
      if (platform === 'win32') {
        // Windows: Use WMIC to get child processes
        const result = execSync(
          `wmic process where (ParentProcessId=${parentPid}) get ProcessId`,
          { encoding: 'utf8' }
        );
        
        const lines = result.split('\n').filter((line: string) => line.trim());
        for (let i = 1; i < lines.length; i++) { // Skip header
          const pid = parseInt(lines[i].trim());
          if (!isNaN(pid) && pid !== parentPid) {
            descendants.push(pid);
            // Recursively get children of this process
            descendants.push(...this.getAllDescendantPids(pid));
          }
        }
      } else {
        // Unix/Linux/macOS: Use ps command
        const result = execSync(
          `ps -o pid= --ppid ${parentPid} 2>/dev/null || true`,
          { encoding: 'utf8' }
        );
        
        const pids = result.split('\n')
          .map((line: string) => parseInt(line.trim()))
          .filter((pid: number) => !isNaN(pid) && pid !== parentPid);
        
        for (const pid of pids) {
          descendants.push(pid);
          // Recursively get children of this process
          descendants.push(...this.getAllDescendantPids(pid));
        }
      }
    } catch (error) {
      console.warn(`Error getting descendant PIDs for ${parentPid}:`, error);
    }
    
    // Remove duplicates
    return [...new Set(descendants)];
  }

  /**
   * Kill a process and all its descendants
   * Returns true if successful, false if zombie processes remain
   */
  private async killProcessTree(pid: number): Promise<boolean> {
    const platform = os.platform();
    const execAsync = promisify(exec);
    
    // First, get all descendant PIDs before we start killing
    const descendantPids = this.getAllDescendantPids(pid);
    
    let success = true;
    
    try {
      if (platform === 'win32') {
        // On Windows, use taskkill to terminate the process tree
        try {
          await execAsync(`taskkill /F /T /PID ${pid}`);
        } catch (error) {
          console.warn(`Error killing Windows process tree: ${error}`);
          // Fallback: kill descendants individually
          for (const childPid of descendantPids) {
            try {
              await execAsync(`taskkill /F /PID ${childPid}`);
            } catch {
              // Process might already be dead
            }
          }
        }
      } else {
        // On Unix-like systems (macOS, Linux)
        // First, try SIGTERM for graceful shutdown
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          console.warn('SIGTERM failed:', error);
        }
        
        // Kill the entire process group using negative PID
        // First, find the actual process group ID
        let pgid = pid;
        try {
          const pgidResult = await execAsync(`ps -o pgid= -p ${pid} 2>/dev/null || echo ""`);
          const foundPgid = parseInt(pgidResult.stdout.trim());
          if (!isNaN(foundPgid)) {
            pgid = foundPgid;
          }
        } catch {
          // Use original PID as fallback
        }
        
        try {
          await execAsync(`kill -TERM -${pgid}`);
        } catch (error) {
          console.warn(`Error sending SIGTERM to process group: ${error}`);
        }
        
        // Give processes 10 seconds to clean up gracefully
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Now forcefully kill the main process
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process might already be dead
        }
        
        // Kill the process group with SIGKILL
        try {
          await execAsync(`kill -9 -${pgid}`);
        } catch (error) {
          console.warn(`Error sending SIGKILL to process group: ${error}`);
        }
        
        // Kill all known descendants individually to be sure
        for (const childPid of descendantPids) {
          try {
            await execAsync(`kill -9 ${childPid}`);
          } catch {
            // Process already terminated
          }
        }
        
        // Final cleanup attempt using pkill
        try {
          await execAsync(`pkill -9 -P ${pid}`);
        } catch {
          // Ignore errors - processes might already be dead
        }
      }
      
      // Verify all processes are actually dead
      await new Promise(resolve => setTimeout(resolve, 500));
      const remainingPids = this.getAllDescendantPids(pid);
      
      if (remainingPids.length > 0) {
        console.error(`WARNING: ${remainingPids.length} zombie processes remain: ${remainingPids.join(', ')}`);
        success = false;
        
        // Emit error event so UI can show warning
        this.emit('zombie-processes-detected', {
          sessionId: null,
          pids: remainingPids,
          message: `Failed to terminate ${remainingPids.length} child processes. Please manually kill PIDs: ${remainingPids.join(', ')}`
        });
      }
    } catch (error) {
      console.error('Error in killProcessTree:', error);
      success = false;
    }

    return success;
  }

  /**
   * Re-spawn every live terminal-session after a ptyHost `UtilityProcess`
   * restart.
   *
   * Order in the supervisor (see `ptyHostSupervisor.onProcExit`):
   *   rejectPendingRpcs → keep manager maps → await nextReady → respawnAll
   *
   * The supervisor intentionally does not emit synthetic exits on host crash.
   * A synthetic exit would run `createTerminalSession`'s `onExit` cleanup and
   * delete the session records this method needs to respawn.
   *
   * Skip rules:
   * - Legacy (non-ptyHost) sessions: supervisor restart is irrelevant;
   *   their `pty.IPty` is still alive.
   * - Shell scrollback is NOT preserved; users see a fresh shell prompt.
   *   That matches the terminal-panel behavior documented in Task 6b.
   */
  async respawnAll(): Promise<void> {
    const snapshots: Array<{ sessionId: string; cwd: string }> = [];

    for (const [sessionId, session] of this.terminalSessions) {
      if (!session.isPtyHost || !session.ptyId) continue;
      snapshots.push({ sessionId, cwd: session.cwd });
    }

    if (snapshots.length === 0) {
      console.log('[ptyHost] TerminalSessionManager respawnAll: no ptyHost-backed sessions to restart');
      return;
    }

    // Drop stale entries so `createTerminalSession`'s duplicate-check
    // (`this.terminalSessions.has(sessionId)`) doesn't early-return.
    for (const { sessionId } of snapshots) {
      this.terminalSessions.delete(sessionId);
    }

    console.log(`[ptyHost] TerminalSessionManager respawnAll: ${snapshots.length} sessions`);

    const results = await Promise.all(
      snapshots.map(async ({ sessionId, cwd }) => {
        try {
          await this.createTerminalSession(sessionId, cwd);
          return { sessionId, ok: true as const };
        } catch (err) {
          console.error(`[ptyHost] respawnAll: createTerminalSession failed for ${sessionId}:`, err);
          return { sessionId, ok: false as const };
        }
      }),
    );

    const ok = results.filter(r => r.ok).length;
    const failed = results.length - ok;
    console.log(`[ptyHost] TerminalSessionManager respawn complete: ${ok} sessions (${failed} failed)`);
  }
}
