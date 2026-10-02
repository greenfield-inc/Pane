import { EventEmitter } from 'events';
import * as pty from '@lydell/node-pty';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../../../../../shared/validation/boundaryDecoder';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import type { Logger } from '../../../utils/logger';
import { getPtyHostRuntime, type PtyHandleLike } from '../../../core/runtime';
import type { ConfigManager } from '../../configManager';
import type { ConversationMessage } from '../../../database/models';
import { getShellPath } from '../../../utils/shellPath';
import { findNodeExecutable } from '../../../utils/nodeFinder';
import { getGitAttributionEnv } from '../../../utils/attribution';
import { interactiveTerminalEnv } from '../../../utils/inheritedProcessEnv';

const LAST_OUTPUT_TAIL_BYTES = 16 * 1024;

/**
 * Minimal shim of the `pty.IPty` surface actually touched by this base class
 * and the three `killProcessTree` implementations in the codebase.
 *
 * Two implementers satisfy this at runtime:
 * - `pty.IPty` directly (legacy path, flag off or supervisor null).
 * - A `PtyHandle`-backed wrapper produced by `spawnViaHost()` (ptyHost path).
 *
 * Synchronous reads of `.pid` in `killProcess` / `getSessionPids` / the
 * `killProcessTree` branch are preserved because the ptyHost spawn response
 * carries the pid and the shim caches it before `spawnViaHost()` resolves.
 *
 * Mutation methods widen the IPty-sync `void` return to `void | Promise<void>`
 * so the `PtyHandle`-backed wrapper (whose methods are async) satisfies the
 * same interface. All existing call sites ignore the return value.
 */
interface PtyLike {
  readonly pid: number;
  write(data: string | Buffer): void | Promise<void>;
  resize(columns: number, rows: number): void | Promise<void>;
  kill(signal?: string): void | Promise<void>;
  pause(): void | Promise<void>;
  resume(): void | Promise<void>;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

interface CliProcess {
  process: PtyLike;
  panelId: string;
  sessionId: string;
  worktreePath: string;
  /**
   * Snapshot of the spawn options used for this process. Required so
   * `respawnAll()` can re-enter `spawnCliProcess` after a ptyHost restart
   * without guessing prompt/isResume/model/permissionMode. Plan Task 6b.
   */
  spawnOptions: CliSpawnOptions;
}

interface AvailabilityCache {
  result: { available: boolean; error?: string; version?: string; path?: string };
  timestamp: number;
}

export interface CliSpawnOptions {
  panelId: string;
  sessionId: string;
  worktreePath: string;
  prompt: string;
  isResume?: boolean;
  [key: string]: JsonValue | undefined; // Allow CLI-specific serializable options
}

export interface CliEnvironment {
  [key: string]: string;
}

export interface CliSpawnTuple {
  cmd: string;
  args: string[];
  env: CliEnvironment;
}

const nodeFallbackTools = new Set<string>();

class PtyHostUnavailableError extends Error {
  readonly code = 'OTHER';
}

interface CliOutputEvent {
  panelId: string;
  sessionId: string;
  type: 'json' | 'stdout' | 'stderr';
  data: unknown;
  timestamp: Date;
}

/**
 * Abstract base class for managing CLI tool processes in Pane
 * Provides common functionality for spawning, managing, and communicating with CLI tools
 */
export abstract class AbstractCliManager extends EventEmitter {
  protected processes: Map<string, CliProcess> = new Map(); // Keyed by panelId
  protected availabilityCache: AvailabilityCache | null = null;
  protected readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache
  protected readonly execAsync = promisify(exec);

  constructor(
    protected sessionManager: import('../../sessionManager').SessionManager,
    protected logger?: Logger,
    protected configManager?: ConfigManager
  ) {
    super();
    // Increase max listeners to prevent warnings when many components listen to events
    this.setMaxListeners(50);
  }

  // Abstract methods that must be implemented by subclasses

  /**
   * Get the CLI tool name (e.g., 'claude', 'aider')
   */
  protected abstract getCliToolName(): string;

  /**
   * Test if the CLI tool is available and get version/path info
   */
  protected abstract testCliAvailability(customPath?: string): Promise<{ available: boolean; error?: string; version?: string; path?: string }>;

  /**
   * Build command arguments for the CLI tool
   */
  protected abstract buildCommandArgs(options: CliSpawnOptions): string[];

  /**
   * Optionally rewrite the resolved spawn tuple (command, args, env) immediately
   * before `spawnPtyProcess` is called. Default is identity. Subclasses override
   * when the target binary needs a sanitized parent process (e.g. wrapping the
   * Bun-compiled Claude CLI in `sh -c 'exec …'` to reset fd/signal inheritance).
   */
  protected wrapSpawnArgs(
    cmd: string,
    args: string[],
    env: CliEnvironment
  ): CliSpawnTuple {
    return { cmd, args, env };
  }

  /**
   * Get the CLI executable path (custom or from PATH)
   */
  protected abstract getCliExecutablePath(): Promise<string>;

  /**
   * Parse and handle CLI output data
   * @param data Raw output data from the CLI
   * @param panelId Panel ID for the output
   * @param sessionId Session ID for the output
   * @returns Array of processed output events
   */
  protected abstract parseCliOutput(data: string, panelId: string, sessionId: string): CliOutputEvent[];

  /**
   * Handle CLI-specific initialization (e.g., setup config files, environment)
   */
  protected abstract initializeCliEnvironment(options: CliSpawnOptions): Promise<CliEnvironment>;

  /**
   * Clean up CLI-specific resources (e.g., config files, temporary files)
   */
  protected abstract cleanupCliResources(sessionId: string): Promise<void>;

  /**
   * Get CLI-specific environment variables
   */
  protected abstract getCliEnvironment(options: CliSpawnOptions): Promise<CliEnvironment>;

  /**
   * Hook called when a CLI process exits. Override in subclasses to clean up process-specific state.
   * Default implementation does nothing.
   */
  protected onProcessExit(_panelId: string, _sessionId: string, _exitCode: number): void {
    // Default implementation - override in subclasses if needed
  }

  // Common functionality that can be shared across CLI tools

  /**
   * Spawn a CLI process for a specific panel
   */
  async spawnCliProcess(options: CliSpawnOptions): Promise<void> {
    try {
      const { panelId, sessionId, worktreePath } = options;
      this.logger?.verbose(`Spawning ${this.getCliToolName()} for panel ${panelId} (session ${sessionId}) in ${worktreePath}`);

      // Test CLI availability (with caching)
      const availability = await this.getCachedAvailability();
      if (!availability.available) {
        await this.handleCliNotAvailable(availability, panelId, sessionId);
        throw new Error(`${this.getCliToolName()} CLI not available: ${availability.error}`);
      }

      this.logger?.verbose(`${this.getCliToolName()} found: ${availability.version || 'version unknown'}`);
      if (availability.path) {
        this.logger?.verbose(`${this.getCliToolName()} executable path: ${availability.path}`);
      }

      // Build command arguments
      const args = this.buildCommandArgs(options);

      // Initialize CLI-specific environment
      const cliEnv = await this.initializeCliEnvironment(options);

      // Get system environment with PATH enhancement
      const systemEnv = await this.getSystemEnvironment();

      // Merge environments
      const env = { ...systemEnv, ...cliEnv };

      // Get CLI executable path
      const cliCommand = await this.getCliExecutablePath();
      
      // Log the exact command being executed
      const fullCommand = `${cliCommand} ${args.join(' ')}`;
      this.logger?.info(`[${this.getCliToolName()}-command] COMMAND: ${fullCommand}`);
      this.logger?.info(`[${this.getCliToolName()}-command] Working directory: ${worktreePath}`);
      this.logger?.info(`[${this.getCliToolName()}-command] Environment vars: ${Object.keys(cliEnv).join(', ')}`);

      // Allow subclasses to wrap the resolved spawn tuple (e.g. sh -c 'exec …'
      // on Unix for the Claude Bun-native binary). Default is identity.
      const { cmd: finalCmd, args: finalArgs, env: finalEnv } = this.wrapSpawnArgs(cliCommand, args, env);

      // Spawn the process
      const ptyProcess = await this.spawnPtyProcess(finalCmd, finalArgs, worktreePath, finalEnv);

      // Create process record. We snapshot `options` verbatim so `respawnAll()`
      // can re-enter `spawnCliProcess` after a ptyHost restart without
      // reconstructing prompt/isResume/model from panel state guesses.
      const cliProcess: CliProcess = {
        process: ptyProcess,
        panelId,
        sessionId,
        worktreePath,
        spawnOptions: options
      };

      this.processes.set(panelId, cliProcess);
      this.logger?.verbose(`${this.getCliToolName()} process created for panel ${panelId} (session ${sessionId})`);

      // Set up process event handlers
      this.setupProcessHandlers(ptyProcess, panelId, sessionId);

      // Emit spawned event
      this.emit('spawned', { panelId, sessionId });

      this.logger?.info(`${this.getCliToolName()} spawned successfully for panel ${panelId} (session ${sessionId})`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger?.error(`Failed to spawn ${this.getCliToolName()} for panel ${options.panelId} (session ${options.sessionId})`, error instanceof Error ? error : undefined);

      this.emit('error', {
        panelId: options.panelId,
        sessionId: options.sessionId,
        error: errorMessage
      });
      throw error;
    }
  }

  /**
   * Send input to a CLI process
   */
  sendInput(panelId: string, input: string): void {
    const cliProcess = this.processes.get(panelId);
    if (!cliProcess) {
      throw new Error(`No ${this.getCliToolName()} process found for panel ${panelId}`);
    }

    // Validate that the process matches the expected panel and session context
    if (cliProcess.panelId !== panelId) {
      this.logger?.error(`[${this.getCliToolName()}] Panel ID mismatch: process has ${cliProcess.panelId}, expected ${panelId}`);
      throw new Error(`Panel ID mismatch: process belongs to different panel`);
    }

    this.logger?.verbose(`[${this.getCliToolName()}] Sending input to panel ${panelId} (session ${cliProcess.sessionId})`);
    cliProcess.process.write(input);
  }

  /**
   * Kill a CLI process and clean up resources
   */
  async killProcess(panelId: string): Promise<void> {
    const cliProcess = this.processes.get(panelId);
    if (!cliProcess) {
      return;
    }

    const { sessionId } = cliProcess;
    const pid = cliProcess.process.pid;

    // Get all child processes before killing
    let killedProcesses: { pid: number; name?: string }[] = [];
    if (pid) {
      const descendantPids = this.getAllDescendantPids(pid);
      if (descendantPids.length > 0) {
        killedProcesses = await this.getProcessInfo(descendantPids);
        this.logger?.info(`[${this.getCliToolName()}] Found ${descendantPids.length} child processes started by ${this.getCliToolName()} for session ${sessionId}`);
      }
    }

    // Clean up CLI-specific resources
    await this.cleanupCliResources(sessionId);

    // Kill the process and all its children
    if (pid) {
      const success = await this.killProcessTree(pid, panelId, sessionId);

      // Report what processes were killed
      if (killedProcesses.length > 0) {
        const processReport = killedProcesses.map(p => `${p.name || 'unknown'}(${p.pid})`).join(', ');
        const message = `\n[Process Cleanup] Terminated ${killedProcesses.length} child process${killedProcesses.length > 1 ? 'es' : ''} started by ${this.getCliToolName()}: ${processReport}\n`;
        this.emit('output', {
          panelId,
          sessionId,
          type: 'stdout',
          data: message,
          timestamp: new Date()
        });
      }

      if (!success) {
        this.logger?.error(`Failed to cleanly terminate all child processes for ${this.getCliToolName()} panel ${panelId} (session ${sessionId})`);
      }
    } else {
      // Fallback to simple kill if no PID
      cliProcess.process.kill();
    }

    this.processes.delete(panelId);
  }

  /**
   * Get a CLI process by panel ID
   */
  getProcess(panelId: string): CliProcess | undefined {
    return this.processes.get(panelId);
  }

  /**
   * Get all active process panel IDs
   */
  getAllProcesses(): string[] {
    return Array.from(this.processes.keys());
  }

  /**
   * Returns a map of sessionId → array of PTY PIDs for that session.
   * Used by resource monitoring to discover which CLI processes belong to which session.
   */
  getSessionPids(): Map<string, number[]> {
    const result = new Map<string, number[]>();
    for (const [, cliProcess] of this.processes) {
      const pid = cliProcess.process.pid;
      if (!pid) continue;
      const pids = result.get(cliProcess.sessionId) || [];
      pids.push(pid);
      result.set(cliProcess.sessionId, pids);
    }
    return result;
  }

  /**
   * Check if a panel is running
   */
  isPanelRunning(panelId: string): boolean {
    return this.processes.has(panelId);
  }

  /**
   * Kill all CLI processes on shutdown
   */
  async killAllProcesses(): Promise<void> {
    const panelIds = Array.from(this.processes.keys());
    this.logger?.info(`[${this.getCliToolName()}] Killing ${panelIds.length} ${this.getCliToolName()} panel processes on shutdown`);

    const killPromises = panelIds.map(panelId => this.killProcess(panelId));
    await Promise.all(killPromises);
  }

  /**
   * Send Ctrl+C (\x03) to all running CLI processes for graceful shutdown.
   * Does NOT kill or remove processes — just signals them to exit gracefully.
   * Caller is responsible for waiting and then hard-killing if needed.
   * @returns number of processes that were signaled
   */
  gracefulSignalAllProcesses(): number {
    let count = 0;
    for (const [panelId, cliProcess] of this.processes) {
      try {
        cliProcess.process.write('\x03');
        this.logger?.info(`[${this.getCliToolName()}] Sent Ctrl+C to panel ${panelId} (session ${cliProcess.sessionId})`);
        count++;
      } catch (error) {
        this.logger?.warn(`[${this.getCliToolName()}] Failed to send Ctrl+C to panel ${panelId}:`, error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.logger?.info(`[${this.getCliToolName()}] Gracefully signaled ${count} processes`);
    return count;
  }

  /**
   * Clear the CLI availability cache
   */
  clearAvailabilityCache(): void {
    this.availabilityCache = null;
    this.logger?.verbose(`[${this.getCliToolName()}Manager] Cleared ${this.getCliToolName()} availability cache`);
  }

  // Abstract methods for CLI-specific implementations

  /**
   * Start a CLI panel with the given options
   * This should be implemented by each CLI tool manager
   */
  abstract startPanel(panelId: string, sessionId: string, worktreePath: string, prompt: string, ...args: unknown[]): Promise<void>;

  /**
   * Continue a CLI panel with conversation history
   * This should be implemented by each CLI tool manager
   */
  abstract continuePanel(panelId: string, sessionId: string, worktreePath: string, prompt: string, conversationHistory: ConversationMessage[], ...args: unknown[]): Promise<void>;

  /**
   * Stop a CLI panel
   * This should be implemented by each CLI tool manager
   */
  abstract stopPanel(panelId: string): Promise<void>;

  /**
   * Restart a panel with conversation history
   * This should be implemented by each CLI tool manager
   */
  abstract restartPanelWithHistory(panelId: string, sessionId: string, worktreePath: string, initialPrompt: string, conversationHistory: ConversationMessage[]): Promise<void>;

  // Legacy session-based methods for backward compatibility
  // These provide default implementations that map to panel-based methods

  /**
   * @deprecated Use startPanel with real panel IDs instead
   */
  async startSession(sessionId: string, worktreePath: string, prompt: string, ...args: unknown[]): Promise<void> {
    console.warn(`[${this.getCliToolName()}Manager] DEPRECATED: startSession called with virtual panel ID for session ${sessionId}. Use real panel IDs instead.`);
    const virtualPanelId = `session-${sessionId}`;
    return this.startPanel(virtualPanelId, sessionId, worktreePath, prompt, ...args);
  }

  /**
   * @deprecated Use continuePanel with real panel IDs instead
   */
  async continueSession(sessionId: string, worktreePath: string, prompt: string, conversationHistory: ConversationMessage[], ...args: unknown[]): Promise<void> {
    console.warn(`[${this.getCliToolName()}Manager] DEPRECATED: continueSession called with virtual panel ID for session ${sessionId}. Use real panel IDs instead.`);
    const virtualPanelId = `session-${sessionId}`;
    return this.continuePanel(virtualPanelId, sessionId, worktreePath, prompt, conversationHistory, ...args);
  }

  /**
   * @deprecated Use stopPanel with real panel IDs instead
   */
  async stopSession(sessionId: string): Promise<void> {
    console.warn(`[${this.getCliToolName()}Manager] DEPRECATED: stopSession called with virtual panel ID for session ${sessionId}. Use real panel IDs instead.`);
    const virtualPanelId = `session-${sessionId}`;
    await this.stopPanel(virtualPanelId);
  }

  /**
   * @deprecated Use isPanelRunning with real panel IDs instead
   */
  isSessionRunning(sessionId: string): boolean {
    console.warn(`[${this.getCliToolName()}Manager] DEPRECATED: isSessionRunning called with virtual panel ID for session ${sessionId}. Use real panel IDs instead.`);
    const virtualPanelId = `session-${sessionId}`;
    return this.isPanelRunning(virtualPanelId);
  }

  // Protected utility methods

  /**
   * Find and store tool-specific session ID for resume functionality
   * This is used by CLI tools that have their own session management systems
   * @param panelId The panel ID
   * @param sessionIdPath Path to search for session files
   * @param extractSessionId Function to extract session ID from a session file
   */
  protected async findAndStoreToolSessionId(
    panelId: string,
    sessionIdPath: string,
    extractSessionId: (filePath: string, worktreePath: string) => Promise<string | null>
  ): Promise<void> {
    try {
      const fs = await import('fs').then(m => m.promises);
      // Check if session directory exists
      try {
        await fs.access(sessionIdPath);
      } catch {
        this.logger?.verbose(`[${this.getCliToolName()}] Session directory not found: ${sessionIdPath}`);
        return;
      }

      // Get the worktree path for this panel
      const process = this.processes.get(panelId);
      if (!process) {
        this.logger?.warn(`[${this.getCliToolName()}] No process found for panel ${panelId}`);
        return;
      }

      // Extract session ID
      const sessionId = await extractSessionId(sessionIdPath, process.worktreePath);
      
      if (sessionId) {
        this.logger?.info(`[${this.getCliToolName()}] Found session ID for panel ${panelId}: ${sessionId}`);
        
        // Store the session ID in the panel's custom state
        if (this.sessionManager) {
          // Use panelManager instead of direct database access
          const { panelManager } = await import('../../panelManager');
          const panel = await panelManager.getPanel(panelId);
          if (panel) {
            const currentState = panel.state || {};
            let customState: JsonObject = {};
            try {
              customState = decodeBoundary(currentState.customState ?? {}, boundary.jsonObject);
            } catch { /* Replace malformed persisted state with a clean object. */ }
            
            // Only update if we don't already have a session ID
            const toolSessionKey = `${this.getCliToolName().toLowerCase()}SessionId`;
            if (!customState[toolSessionKey]) {
              const updatedState = {
                ...currentState,
                customState: { ...customState, [toolSessionKey]: sessionId }
              };
              
              await panelManager.updatePanel(panelId, { state: updatedState });
              this.logger?.verbose(`[${this.getCliToolName()}] Stored session ID in panel ${panelId}: ${sessionId}`);
            }
          }
        }
      } else {
        this.logger?.verbose(`[${this.getCliToolName()}] No session ID found for panel ${panelId}`);
      }
    } catch (error) {
      this.logger?.error(`[${this.getCliToolName()}] Error finding session ID: ${error}`);
    }
  }

  /**
   * Get cached availability result or perform fresh check
   */
  async getCachedAvailability(): Promise<{ available: boolean; error?: string; version?: string; path?: string }> {
    if (this.availabilityCache &&
        (Date.now() - this.availabilityCache.timestamp) < this.CACHE_TTL) {
      this.logger?.verbose(`Using cached ${this.getCliToolName()} availability check`);
      return this.availabilityCache.result;
    }

    // Perform fresh check
    const availability = await this.testCliAvailability();

    // Cache the result
    this.availabilityCache = {
      result: availability,
      timestamp: Date.now()
    };

    return availability;
  }

  /**
   * Handle CLI not available error
   */
  protected async handleCliNotAvailable(availability: { available: boolean; error?: string }, panelId: string, sessionId: string): Promise<void> {
    this.logger?.error(`${this.getCliToolName()} not available: ${availability.error}`);
    this.logger?.error(`Current PATH: ${process.env.PATH}`);
    this.logger?.error(`Enhanced PATH searched: ${getShellPath()}`);

    // Emit error message to show in the UI
    const errorMessage = {
      type: 'session',
      data: {
        status: 'error',
        message: `${this.getCliToolName()} not available`,
        details: this.getCliNotAvailableMessage(availability.error)
      }
    };

    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: errorMessage,
      timestamp: new Date()
    });

    // Add dedicated error output
    this.sessionManager.addSessionError(
      sessionId,
      `${this.getCliToolName()} not available`,
      `${availability.error}\nPlease install ${this.getCliToolName()} or verify it is in your PATH.`
    );
  }

  /**
   * Get CLI not available error message (can be overridden by subclasses)
   */
  protected getCliNotAvailableMessage(error?: string): string {
    return [
      `Error: ${error}`,
      '',
      `${this.getCliToolName()} is not installed or not found in your PATH.`,
      '',
      `Please install ${this.getCliToolName()}:`,
      '1. Follow the installation instructions for your platform',
      `2. Verify installation by running "${this.getCliToolName()} --version" in your terminal`,
      '',
      `If ${this.getCliToolName()} is installed but not in your PATH:`,
      `- Add the ${this.getCliToolName()} installation directory to your PATH environment variable`,
      '- Or set a custom executable path in Pane Settings',
      '',
      `Enhanced PATH searched: ${getShellPath()}`,
      `Attempted command: ${this.getCliToolName()} --version`
    ].join('\n');
  }

  /**
   * Get enhanced system environment with PATH
   * Uses centralized shellPath utility for consistent PATH management
   */
  protected async getSystemEnvironment(): Promise<{ [key: string]: string }> {
    // Get the enhanced PATH from centralized utility (includes Linux-specific paths)
    const shellPath = getShellPath();

    // Find Node.js and ensure it's in the PATH
    const nodePath = await findNodeExecutable();
    const nodeDir = path.dirname(nodePath);
    const pathSeparator = process.platform === 'win32' ? ';' : ':';
    
    // Combine Node.js directory with enhanced PATH
    const pathWithNode = nodeDir + pathSeparator + shellPath;

    return {
      ...interactiveTerminalEnv(),
      ...getGitAttributionEnv(this.configManager?.getConfig()),
      PATH: pathWithNode
    };
  }


  /**
   * Spawn PTY process with error handling and Node.js fallback
   * This handles the common case where CLI tools are Node.js scripts with shebangs
   * that may not work correctly on all systems.
   *
   * When the `usePtyHost` setting is on (and a live supervisor), both spawn
   * attempts are routed through `spawnViaHost`. The Node-fallback classifier below still
   * runs in main: ptyHost rejects with a `.code`-tagged error (see
   * `PtyHostSpawnError` / `rpc.ts:toError`) AND preserves the original message,
   * so the substring-based branching at lines ~717 continues to match.
   * `withLock('claude-spawn-<panelId>')` at `claudeCodeManager.ts:438-439`
   * wraps this call; on supervisor restart mid-RPC, the reject with
   * `PTY_HOST_RESTARTED` propagates through and the lock's try/finally
   * releases normally.
   */
  protected async spawnPtyProcess(command: string, args: string[], cwd: string, env: { [key: string]: string }): Promise<PtyLike> {
    if (!pty) {
      throw new Error('node-pty not available');
    }

    const fullCommand = `${command} ${args.join(' ')}`;
    this.logger?.verbose(`Executing ${this.getCliToolName()} command: ${fullCommand}`);
    this.logger?.verbose(`Working directory: ${cwd}`);

    // A missing cwd (e.g. a worktree removed while the session was archived)
    // makes node-pty fail with an opaque spawn error; report it clearly instead.
    if (!fs.existsSync(cwd)) {
      throw new Error(`Cannot start ${this.getCliToolName()}: working directory does not exist: ${cwd}. Restore or recreate the session's worktree and try again.`);
    }

    let ptyProcess: PtyLike;
    let spawnAttempt = 0;
    let lastError: unknown;
    const toolName = this.getCliToolName().toLowerCase();
    const needsNodeFallbackKey = `${toolName}NeedsNodeFallback`;

    // On Windows, always use Node.js fallback because:
    // 1. npm bin stubs are shell scripts that node-pty can't execute directly (error 193)
    // 2. Even if we could execute them, they use relative paths that break when cwd differs
    if (os.platform() === 'win32') {
      this.logger?.verbose(`[${this.getCliToolName()}] Windows detected, using Node.js fallback proactively`);
      nodeFallbackTools.add(needsNodeFallbackKey);
    }

    // Try normal spawn first, then fallback to Node.js invocation if it fails
    while (spawnAttempt < 2) {
      try {
        const startTime = Date.now();

        // On Linux, add a small delay before spawning to avoid resource contention
        if (os.platform() === 'linux' && this.processes.size > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        const supervisor = getPtyHostRuntime();
        const useHost = (this.configManager?.getUsePtyHost() ?? false) && supervisor !== null;

        if (spawnAttempt === 0 && !nodeFallbackTools.has(needsNodeFallbackKey)) {
          // First attempt: normal spawn
          ptyProcess = useHost
            ? await this.spawnViaHost(command, args, cwd, env, 80, 30)
            : pty.spawn(command, args, {
                name: 'xterm-color',
                cols: 80,
                rows: 30,
                cwd,
                env
              });
        } else {
          // Second attempt or if we know we need Node.js: use Node.js directly.
          // The Phase 0 `wrapSpawnArgs` hook fires ONCE in `spawnCliProcess` before
          // entering this loop, so the Node-fallback branch operates on the
          // unwrapped `(nodePath, nodeArgs)` pair. Claude v2.1.113+ is a native
          // binary that never trips the fallback; v1.x Node-based Claude still
          // works because sh exec'd the Node wrapper transparently on attempt 1.
          this.logger?.verbose(`[${this.getCliToolName()}] Using Node.js fallback for execution`);

          // Try to find the CLI script (for npm-installed tools)
          let scriptPath = command;

          // For tools installed via npm, the command might be a symlink to a script
          // Try using the nodeFinder utility to locate the actual script
          try {
            // Use dynamic import to avoid circular dependencies
            const { findCliNodeScript } = await import('../../../utils/nodeFinder');
            const foundScript = findCliNodeScript(command);
            if (foundScript) {
              scriptPath = foundScript;
              this.logger?.verbose(`[${this.getCliToolName()}] Found script at: ${scriptPath}`);
            }
          } catch {
            // If we can't find the script helper, just use the command as-is
            this.logger?.verbose(`[${this.getCliToolName()}] Using command directly for Node.js invocation`);
          }

          const nodePath = await findNodeExecutable();
          this.logger?.verbose(`[${this.getCliToolName()}] Using Node.js: ${nodePath}`);

          // Spawn with Node.js directly
          const nodeArgs = scriptPath === command
            ? [command, ...args] // Command might be a direct script path
            : ['--no-warnings', '--enable-source-maps', scriptPath, ...args]; // Found script path

          ptyProcess = useHost
            ? await this.spawnViaHost(nodePath, nodeArgs, cwd, env, 80, 30)
            : pty.spawn(nodePath, nodeArgs, {
                name: 'xterm-color',
                cols: 80,
                rows: 30,
                cwd,
                env
              });
        }

        const spawnTime = Date.now() - startTime;
        this.logger?.verbose(`${this.getCliToolName()} process spawned successfully in ${spawnTime}ms`);
        return ptyProcess;
      } catch (spawnError) {
        lastError = spawnError;
        spawnAttempt++;

        if (spawnAttempt === 1 && !nodeFallbackTools.has(needsNodeFallbackKey)) {
          const errorMsg = spawnError instanceof Error ? spawnError.message : String(spawnError);
          this.logger?.error(`First ${this.getCliToolName()} spawn attempt failed: ${errorMsg}`);

          // Check for typical shebang-related errors or Windows executable format errors
          // Error code 193 on Windows means "not a valid Win32 application" - happens when
          // trying to execute a shell script (like npm bin stubs) directly
          if (errorMsg.includes('No such file or directory') ||
              errorMsg.includes('env: node:') ||
              errorMsg.includes('is not recognized') ||
              errorMsg.includes('ENOENT') ||
              errorMsg.includes('error code: 193') ||
              errorMsg.includes('not a valid Win32 application')) {
            this.logger?.verbose(`Error suggests shebang issue or Windows executable format error, will try Node.js fallback`);
            nodeFallbackTools.add(needsNodeFallbackKey);
            continue;
          }
        }
        break;
      }
    }

    // If we failed after all attempts, handle the error
    const errorMsg = lastError instanceof Error ? lastError.message : String(lastError);
    this.logger?.error(`Failed to spawn ${this.getCliToolName()} process after ${spawnAttempt} attempts: ${errorMsg}`);
    throw new Error(`Failed to spawn ${this.getCliToolName()}: ${errorMsg}`);
  }

  /**
   * Spawn the CLI binary through the ptyHost `UtilityProcess` and return a
   * `PtyLike`-compatible shim. The shim caches `pid` from the spawn response
   * so synchronous `.pid` reads (killProcess, getSessionPids, killProcessTree)
   * remain synchronous.
   *
   * Error mapping: on reject, the supervisor's `RpcDispatcher` converts the
   * host's `PtyHostSpawnError` into an `Error` with the original `message`
   * preserved verbatim AND a `.code` property set to one of
   * `ENOENT | E193 | SHEBANG | OTHER` (see `rpc.ts:toError`). The two-attempt
   * classifier above branches on the message substring, so the existing
   * shebang / ENOENT / Windows-193 checks continue to match transparently.
   * The `.code` property is preserved on the thrown error for any future
   * callers that want to branch on it directly.
   */
  private async spawnViaHost(
    cmd: string,
    args: string[],
    cwd: string,
    env: { [key: string]: string },
    cols: number,
    rows: number
  ): Promise<PtyLike> {
    const supervisor = getPtyHostRuntime();
    if (!supervisor) {
      // Guard: caller must have checked already; if we got here without one,
      // surface a classifier-agnostic OTHER to avoid accidental fallback.
      throw new PtyHostUnavailableError('ptyHost supervisor not available');
    }

    const { ptyId, pid } = await supervisor.spawn({
      shell: cmd,
      args,
      cwd,
      cols,
      rows,
      env,
      name: 'xterm-256color',
    });

    const handle = supervisor.getHandle(ptyId);
    if (!handle) {
      // This shouldn't happen: supervisor.spawn() registers the handle before
      // resolving. If it does, treat as OTHER so the fallback path doesn't fire.
      throw new PtyHostUnavailableError(`ptyHost returned ptyId ${ptyId} but no handle`);
    }

    return this.wrapPtyHandle(handle, pid);
  }

  /**
   * Adapt a `PtyHandle` to the `PtyLike` surface this base class uses. The
   * adapter is strictly local; it converts `PtyHandle.onExit`'s positional
   * `(exitCode, signal)` shape to the `{exitCode, signal}` object shape the
   * rest of this file (and `pty.IPty`) expects.
   */
  private wrapPtyHandle(handle: PtyHandleLike, pid: number): PtyLike {
    return {
      pid,
      write(data: string | Buffer): Promise<void> {
        return handle.write(Buffer.isBuffer(data) ? data.toString('utf8') : data);
      },
      resize(columns: number, rowsValue: number): Promise<void> {
        return handle.resize(columns, rowsValue);
      },
      kill(signal?: string): Promise<void> {
        // SAFETY: PtyLike callers use Node signal names; this adapter merely
        // narrows the legacy string signature for the typed ptyHost handle.
        return handle.kill(signal as NodeJS.Signals | undefined);
      },
      pause(): Promise<void> {
        return handle.pause();
      },
      resume(): Promise<void> {
        return handle.resume();
      },
      onData(listener: (data: string) => void) {
        return handle.onData(listener);
      },
      onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
        // Preserve the raw signal number; SIGSEGV/SIGABRT/SIGBUS detection at
        // `setupProcessHandlers` depends on it. Widen `exitCode: number | null`
        // to `number` by passing it through; downstream code already tolerates
        // null via `exitCode ?? 0` / `exitCode !== 0`.
        return handle.onExit((exitCode, signal) => {
          listener({
            exitCode: (exitCode ?? 0),
            signal: signal ?? undefined,
          });
        });
      },
    };
  }

  /**
   * Re-spawn every live CLI process after a ptyHost `UtilityProcess` restart.
   *
   * Order inside the supervisor (see `ptyHostSupervisor.onProcExit`):
   *   rejectPendingRpcs → keep manager maps → await nextReady → respawnAll
   *
   * The supervisor intentionally does not emit synthetic exits on host crash.
   * A synthetic exit would run this file's `onExit` cleanup and delete the
   * process records we need to snapshot here.
   *
   * Per-panel work is delegated to `respawnPanel()` so subclasses (Claude)
   * can wrap each re-entry in their `withLock('claude-spawn-<panelId>')`
   * envelope without duplicating the iteration logic here.
   *
   * Plan Task 6b: "Run per-panel respawns in parallel via Promise.all."
   */
  async respawnAll(): Promise<void> {
    const entries = Array.from(this.processes.entries());
    if (entries.length === 0) {
      this.logger?.info(`[ptyHost] ${this.getCliToolName()} respawnAll: no live panels`);
      return;
    }

    this.logger?.info(`[ptyHost] ${this.getCliToolName()} respawnAll: ${entries.length} panels`);

    const results = await Promise.all(entries.map(async ([panelId, cliProcess]) => {
      // Snapshot the options BEFORE clearing the stale entry; the entry's
      // `spawnOptions` still points at the pre-restart invocation.
      const snapshot = cliProcess.spawnOptions;

      // Clear the stale entry so the re-entry's `spawnCliProcess` duplicate
      // check doesn't throw.
      this.processes.delete(panelId);

      // Skip panels whose CLI never finished spawning. The pending RPC
      // rejection (`PTY_HOST_RESTARTED`) already propagated the error up to
      // the original caller's `spawnCliProcess` promise, whose error-handler
      // runs its own cleanup. Re-spawning here would duplicate work.
      if (this.isSpawnInProgress(panelId)) {
        this.logger?.warn(`[ptyHost] ${this.getCliToolName()} skipping respawn for ${panelId}: spawn in progress at restart`);
        return { panelId, skipped: 'in-progress' as const };
      }

      // Skip non-interactive `-p` spawns. The prompt is not recoverable from
      // panel state alone and re-running the original prompt after a mid-flight
      // crash risks double-executing work the user already saw partially complete.
      if (this.isNonInteractiveSpawn(snapshot)) {
        this.logger?.warn(`[ptyHost] ${this.getCliToolName()} skipping respawn for ${panelId}: non-interactive -p spawn interrupted`);
        this.emit('output', {
          panelId,
          sessionId: cliProcess.sessionId,
          type: 'stderr',
          data: `\n[${this.getCliToolName()}] ptyHost restarted mid-spawn; non-interactive prompt lost. Start a new message to continue.\n`,
          timestamp: new Date()
        });
        return { panelId, skipped: 'non-interactive' as const };
      }

      try {
        await this.respawnPanel(snapshot);
        return { panelId, skipped: false as const };
      } catch (err) {
        this.logger?.error(`[ptyHost] ${this.getCliToolName()} respawn failed for ${panelId}:`, err instanceof Error ? err : undefined);
        return { panelId, skipped: 'error' as const };
      }
    }));

    const respawned = results.filter(r => r.skipped === false).length;
    const skipped = results.length - respawned;
    this.logger?.info(`[ptyHost] ${this.getCliToolName()} respawn complete: ${respawned} respawned, ${skipped} skipped`);
  }

  /**
   * Re-enter the spawn flow for a single panel. Base implementation calls
   * `spawnCliProcess(options)` directly. Subclasses (e.g. `ClaudeCodeManager`)
   * override to wrap in their per-panel lock so a concurrent user-initiated
   * spawn cannot race with the restart-driven respawn.
   *
   * Not a public entry point — only called from `respawnAll`.
   */
  protected async respawnPanel(options: CliSpawnOptions): Promise<void> {
    await this.spawnCliProcess(options);
  }

  /**
   * Hook for subclasses to tell respawnAll whether the pre-restart spawn had
   * completed enough that re-entering makes sense. Default: always respawn.
   * `ClaudeCodeManager` overrides to check `isCliReady` on the panel state.
   */
  protected isSpawnInProgress(_panelId: string): boolean {
    return false;
  }

  /**
   * Hook for subclasses to tell respawnAll whether the pre-restart spawn was
   * a non-interactive `-p` invocation that can't be reproduced after a crash.
   * Default: false. `ClaudeCodeManager` overrides to check `isInteractive`.
   */
  protected isNonInteractiveSpawn(_options: CliSpawnOptions): boolean {
    return false;
  }

  /**
   * Set up event handlers for a PTY process
   */
  protected setupProcessHandlers(ptyProcess: PtyLike, panelId: string, sessionId: string): void {
    let hasReceivedOutput = false;
    let lastOutput = '';
    let buffer = '';

    ptyProcess.onData((data: string) => {
      hasReceivedOutput = true;
      const combined = lastOutput + data;
      lastOutput = combined.length > LAST_OUTPUT_TAIL_BYTES
        ? combined.slice(-LAST_OUTPUT_TAIL_BYTES)
        : combined;
      buffer += data;

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          const outputEvents = this.parseCliOutput(line + '\n', panelId, sessionId);
          for (const event of outputEvents) {
            this.emit('output', event);
          }
        }
      }
    });

    ptyProcess.onExit(async ({ exitCode, signal }) => {
      // Check for and kill any child processes
      const pid = ptyProcess.pid;
      if (pid) {
        const descendantPids = this.getAllDescendantPids(pid);
        if (descendantPids.length > 0) {
          const killedProcesses = await this.getProcessInfo(descendantPids);
          this.logger?.info(`[${this.getCliToolName()}] Found ${descendantPids.length} orphaned child processes after ${this.getCliToolName()} exit for session ${sessionId}`);

          await this.killProcessTree(pid, panelId, sessionId);

          const processReport = killedProcesses.map(p => `${p.name || 'unknown'}(${p.pid})`).join(', ');
          const message = `\n[Process Cleanup] Terminated ${killedProcesses.length} orphaned child process${killedProcesses.length > 1 ? 'es' : ''} after ${this.getCliToolName()} exit: ${processReport}\n`;
          this.emit('output', {
            panelId,
            sessionId,
            type: 'stdout',
            data: message,
            timestamp: new Date()
          });
        }
      }

      // Process any remaining data in the buffer
      if (buffer.trim()) {
        const outputEvents = this.parseCliOutput(buffer, panelId, sessionId);
        for (const event of outputEvents) {
          this.emit('output', event);
        }
      }

      // Detect crash signals (SIGSEGV=11, SIGABRT=6, SIGBUS=7)
      if (signal && [6, 7, 11].includes(signal)) {
        const signalName = signal === 6 ? 'SIGABRT' : signal === 7 ? 'SIGBUS' : 'SIGSEGV';
        this.logger?.error(`${this.getCliToolName()} process crashed with ${signalName} for session ${sessionId} (panel ${panelId})`);

        const crashMessage = `\n[Process Crash] ${this.getCliToolName()} was terminated by ${signalName}. Your system may be under memory pressure — check RAM usage.\n`;
        this.emit('output', {
          panelId,
          sessionId,
          type: 'stderr',
          data: crashMessage,
          timestamp: new Date()
        });
      }

      if (exitCode !== 0) {
        this.logger?.error(`${this.getCliToolName()} process failed for session ${sessionId}. Exit code: ${exitCode}, Signal: ${signal}`);

        if (!hasReceivedOutput) {
          await this.handleProcessStartupFailure(exitCode, signal, panelId, sessionId, lastOutput);
        } else {
          await this.handleProcessRuntimeFailure(exitCode, signal, panelId, sessionId, lastOutput);
        }
      } else {
        this.logger?.info(`${this.getCliToolName()} process exited normally for panel ${panelId} (session ${sessionId})`);
      }

      // Clean up CLI-specific resources
      await this.cleanupCliResources(sessionId);

      // Allow subclasses to handle process exit (e.g., clean up interactive mode state)
      this.onProcessExit(panelId, sessionId, exitCode ?? 0);

      this.emit('exit', {
        panelId,
        sessionId,
        exitCode,
        signal: signal ?? null
      });
      this.processes.delete(panelId);
    });
  }

  /**
   * Handle process startup failure
   */
  protected async handleProcessStartupFailure(exitCode: number | null, signal: number | undefined, panelId: string, sessionId: string, _lastOutput: string): Promise<void> {
    this.logger?.error(`No output received from ${this.getCliToolName()}. This might indicate a startup failure.`);

    const errorMessage = {
      type: 'session',
      data: {
        status: 'error',
        message: `${this.getCliToolName()} failed to start (exit code: ${exitCode})`,
        details: [
          `This usually means ${this.getCliToolName()} is not installed properly or not found in your PATH.`,
          '',
          'Please ensure:',
          `1. ${this.getCliToolName()} is installed`,
          `2. The "${this.getCliToolName()}" command is available in your terminal`,
          '3. Your PATH environment variable includes the installation directory',
          '',
          `Exit code: ${exitCode}${signal ? `, Signal: ${signal}` : ''}`,
          '',
          'You can also set a custom executable path in the Settings.'
        ].join('\n')
      }
    };

    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: errorMessage,
      timestamp: new Date()
    });
  }

  /**
   * Handle process runtime failure
   */
  protected async handleProcessRuntimeFailure(exitCode: number | null, signal: number | undefined, panelId: string, sessionId: string, lastOutput: string): Promise<void> {
    this.logger?.error(`Last output from ${this.getCliToolName()}: ${lastOutput.slice(-500)}`);

    const errorMessage = {
      type: 'session',
      data: {
        status: 'error',
        message: `${this.getCliToolName()} exited with error (exit code: ${exitCode})`,
        details: lastOutput.length > 0 ? `Last output:\n${lastOutput.slice(-500)}` : 'No additional details available'
      }
    };

    this.emit('output', {
      panelId,
      sessionId,
      type: 'json',
      data: errorMessage,
      timestamp: new Date()
    });
  }

  // Process management utilities

  /**
   * Get all descendant PIDs of a parent process recursively
   */
  protected getAllDescendantPids(parentPid: number): number[] {
    const descendants: number[] = [];
    const platform = os.platform();

    try {
      if (platform === 'win32') {
        const result = execSync(
          `wmic process where (ParentProcessId=${parentPid}) get ProcessId`,
          { encoding: 'utf8' }
        );

        const lines = result.split('\n').filter((line: string) => line.trim());
        for (let i = 1; i < lines.length; i++) {
          const pid = parseInt(lines[i].trim());
          if (!isNaN(pid) && pid !== parentPid) {
            descendants.push(pid);
            descendants.push(...this.getAllDescendantPids(pid));
          }
        }
      } else {
        const result = execSync(
          `ps -o pid= --ppid ${parentPid} 2>/dev/null || true`,
          { encoding: 'utf8' }
        );

        const pids = result.split('\n')
          .map((line: string) => parseInt(line.trim()))
          .filter((pid: number) => !isNaN(pid) && pid !== parentPid);

        for (const pid of pids) {
          descendants.push(pid);
          descendants.push(...this.getAllDescendantPids(pid));
        }
      }
    } catch (error) {
      this.logger?.warn(`Error getting descendant PIDs for ${parentPid}:`, error instanceof Error ? error : new Error(String(error)));
    }

    return [...new Set(descendants)];
  }

  /**
   * Get process information for a list of PIDs
   */
  protected async getProcessInfo(pids: number[]): Promise<{ pid: number; name?: string }[]> {
    const processInfo: { pid: number; name?: string }[] = [];
    const platform = os.platform();

    for (const pid of pids) {
      try {
        let name: string | undefined;

        if (platform === 'win32') {
          const result = execSync(
            `wmic process where ProcessId=${pid} get Name`,
            { encoding: 'utf8' }
          );
          const lines = result.split('\n').filter((line: string) => line.trim());
          if (lines.length > 1) {
            name = lines[1].trim();
          }
        } else {
          const result = execSync(
            `ps -p ${pid} -o comm= 2>/dev/null || true`,
            { encoding: 'utf8' }
          );
          name = result.trim();
        }

        processInfo.push({ pid, name: name || 'unknown' });
      } catch {
        processInfo.push({ pid, name: 'unknown' });
      }
    }

    return processInfo;
  }

  /**
   * Kill a process and all its descendants
   */
  protected async killProcessTree(pid: number, panelId: string, sessionId: string): Promise<boolean> {
    const platform = os.platform();

    const descendantPids = this.getAllDescendantPids(pid);
    this.logger?.info(`[${this.getCliToolName()}] Found ${descendantPids.length} descendant processes for PID ${pid} in session ${sessionId}`);

    let success = true;

    try {
      if (platform === 'win32') {
        try {
          await this.execAsync(`taskkill /F /T /PID ${pid}`);
          this.logger?.verbose(`[${this.getCliToolName()}] Successfully killed Windows process tree ${pid}`);
        } catch (error) {
          this.logger?.warn(`[${this.getCliToolName()}] Error killing Windows process tree: ${error instanceof Error ? error : new Error(String(error))}`);
          for (const childPid of descendantPids) {
            try {
              await this.execAsync(`taskkill /F /PID ${childPid}`);
            } catch {
              // Process might already be dead
            }
          }
        }
      } else {
        // Unix-like systems
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          this.logger?.warn(`[${this.getCliToolName()}] SIGTERM failed:`, error instanceof Error ? error : new Error(String(error)));
        }

        // Kill the entire process group
        try {
          await this.execAsync(`kill -TERM -${pid}`);
        } catch (error) {
          this.logger?.warn(`[${this.getCliToolName()}] Error sending SIGTERM to process group: ${error}`);
        }

        // Give processes a chance to clean up gracefully
        await new Promise(resolve => setTimeout(resolve, 200));

        // Force kill
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process might already be dead
        }

        try {
          await this.execAsync(`kill -9 -${pid}`);
        } catch (error) {
          this.logger?.warn(`[${this.getCliToolName()}] Error sending SIGKILL to process group: ${error}`);
        }

        // Kill all known descendants individually
        for (const childPid of descendantPids) {
          try {
            await this.execAsync(`kill -9 ${childPid}`);
            this.logger?.verbose(`[${this.getCliToolName()}] Killed descendant process ${childPid}`);
          } catch {
            this.logger?.verbose(`[${this.getCliToolName()}] Process ${childPid} already terminated`);
          }
        }

        // Final cleanup attempt
        try {
          await this.execAsync(`pkill -9 -P ${pid}`);
        } catch {
          // Ignore errors - processes might already be dead
        }
      }

      // Verify all processes are actually dead
      await new Promise(resolve => setTimeout(resolve, 500));
      const remainingPids = this.getAllDescendantPids(pid);

      if (remainingPids.length > 0) {
        this.logger?.error(`[${this.getCliToolName()}] WARNING: ${remainingPids.length} zombie processes remain: ${remainingPids.join(', ')}`);
        success = false;

        const remainingProcesses = await this.getProcessInfo(remainingPids);
        const processReport = remainingProcesses.map(p => `${p.name || 'unknown'}(${p.pid})`).join(', ');

        this.emit('output', {
          panelId,
          sessionId,
          type: 'stderr',
          data: `\n[WARNING] Failed to terminate ${remainingPids.length} child process${remainingPids.length > 1 ? 'es' : ''}: ${processReport}\nPlease manually kill these processes.\n`,
          timestamp: new Date()
        });
      }
    } catch (error) {
      this.logger?.error(`[${this.getCliToolName()}] Error in killProcessTree:`, error instanceof Error ? error : new Error(String(error)));
      success = false;
    }

    // Always try to kill via pty interface as final fallback
    try {
      const cliProcess = this.processes.get(panelId);
      if (cliProcess) {
        cliProcess.process.kill();
      }
    } catch {
      // Process might already be dead
    }

    return success;
  }
}
