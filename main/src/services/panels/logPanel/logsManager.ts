import { ChildProcess, spawn, exec, execSync } from 'child_process';
import * as os from 'os';
import { ToolPanel, LogsPanelState } from '../../../../../shared/types/panels';
import { getPaneEventSink } from '../../../core/runtime';
import { panelManager } from '../../panelManager';
import { addSessionLog, clearSessionLogs } from '../../session-logs';
import { getShellPath } from '../../../utils/shellPath';
import type { AnalyticsManager } from '../../analyticsManager';
import type { PaneEventArgument } from '../../../core/eventSink';
import { WSLContext, buildWSLENV } from '../../../utils/wslUtils';

function getLogsPanelState(panel: ToolPanel): LogsPanelState {
  // SAFETY: This manager only creates and receives panels with type `logs`,
  // whose custom state is owned here and always initialized as LogsPanelState.
  return panel.state.customState as LogsPanelState;
}

export class LogsManager {
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  private static instance: LogsManager;
  private activeProcesses = new Map<string, ChildProcess>(); // panelId -> process
  private scriptStartTimes = new Map<string, number>(); // panelId -> start timestamp
  private analyticsManager: AnalyticsManager | null = null;
  
  static getInstance(): LogsManager {
    if (!LogsManager.instance) {
      LogsManager.instance = new LogsManager();
    }
    return LogsManager.instance;
  }

  /**
   * Set the analytics manager for tracking script executions
   */
  setAnalyticsManager(analyticsManager: AnalyticsManager): void {
    this.analyticsManager = analyticsManager;
  }

  private sendRendererEvent(channel: string, ...args: PaneEventArgument[]): void {
    getPaneEventSink().send(channel, ...args);
  }

  /**
   * Get or create singleton logs panel for session
   */
  async getOrCreateLogsPanel(sessionId: string): Promise<ToolPanel> {
    const panels = await panelManager.getPanelsForSession(sessionId);
    const existingLogs = panels.find((p: ToolPanel) => p.type === 'logs');
    
    if (existingLogs) {
      // Clear existing panel output
      await this.clearPanel(existingLogs.id);
      
      // Emit panel:created event to ensure frontend adds it back if it was closed
      // This is necessary because closing a panel in the frontend removes it from the store
      // but doesn't delete it from the backend database
      this.sendRendererEvent('panel:created', existingLogs);
      
      return existingLogs;
    }
    
    // Create new logs panel
    return await panelManager.createPanel({
      sessionId,
      type: 'logs',
      title: 'Logs'
    });
  }
  
  /**
   * Clear panel output and reset state
   */
  async clearPanel(panelId: string): Promise<void> {
    const panel = await panelManager.getPanel(panelId);
    if (!panel) return;
    
    // Clear session logs
    clearSessionLogs(panel.sessionId);
    
    // Reset panel state
    await panelManager.updatePanel(panelId, {
      state: {
        ...panel.state,
        customState: {
          isRunning: false,
          processId: undefined,
          command: undefined,
          startTime: undefined,
          endTime: undefined,
          exitCode: undefined,
          errorCount: 0,
          warningCount: 0,
          lastActivityTime: undefined
        }
      }
    });
  }
  
  /**
   * Run a script in the logs panel
   */
  async runScript(sessionId: string, command: string, cwd: string, wslContext?: WSLContext | null): Promise<void> {
    // Get or create logs panel
    const panel = await this.getOrCreateLogsPanel(sessionId);

    // Stop any existing process for this panel
    await this.stopScript(panel.id);

    // Clear previous content
    await this.clearPanel(panel.id);

    // Small delay to ensure frontend processes the clear event
    await new Promise(resolve => setTimeout(resolve, 50));

    // Update panel state to running
    const startTime = new Date().toISOString();

    // Record start time for analytics tracking
    this.scriptStartTimes.set(panel.id, Date.now());

    await panelManager.updatePanel(panel.id, {
      state: {
        ...panel.state,
        customState: {
          isRunning: true,
          command,
          startTime,
          errorCount: 0,
          warningCount: 0,
          lastActivityTime: startTime
        }
      }
    });

    // Make panel active
    await panelManager.setActivePanel(sessionId, panel.id);

    // Emit process started event
    this.sendRendererEvent('panel:event', {
      type: 'process:started',
      source: {
        panelId: panel.id,
        panelType: 'logs',
        sessionId
      },
      data: { command, cwd },
      timestamp: startTime
    });

    // Get enhanced shell PATH for packaged apps
    const shellPath = getShellPath();

    // Compute PANE_PORT — deterministic 10-port block per session for parallel dev servers
    let portHash = 0;
    for (let i = 0; i < sessionId.length; i++) {
      portHash = ((portHash << 5) - portHash) + sessionId.charCodeAt(i);
      portHash |= 0;
    }
    const panePort = String(3000 + (Math.abs(portHash) % 600) * 10);

    // Start process with shell
    let childProcess: ChildProcess;

    if (wslContext) {
      // Env vars set on the wsl.exe Windows process do not cross into the distro shell;
      // WSLENV tells WSL to copy the listed vars into the Linux env (see buildWSLENV docs)
      childProcess = this.spawnProcess('wsl.exe', ['-d', wslContext.distribution, '--', 'bash', '-c', `cd '${cwd}' && ${command}`], {
        env: {
          ...process.env,
          PATH: shellPath,
          PANE_PORT: panePort,
          PANE_WORKSPACE_PATH: cwd,
          WSLENV: buildWSLENV(['PANE_PORT', 'PANE_WORKSPACE_PATH'])
        }
      });
    } else {
      childProcess = this.spawnProcess(command, [], {
        cwd,
        shell: true,
        env: {
          ...process.env,
          PATH: shellPath,
          PANE_PORT: panePort,
          PANE_WORKSPACE_PATH: cwd
        }
      });
    }
    
    if (childProcess.pid) {
      // Store process reference
      this.activeProcesses.set(panel.id, childProcess);
      
      // Update panel with process ID
      await panelManager.updatePanel(panel.id, {
        state: {
          ...panel.state,
          customState: {
            ...getLogsPanelState(panel),
            processId: childProcess.pid
          }
        }
      });
      
      // Stream stdout
      childProcess.stdout?.on('data', (data) => {
        this.handleOutput(panel.id, sessionId, data.toString(), 'stdout');
      });
      
      // Stream stderr
      childProcess.stderr?.on('data', (data) => {
        this.handleOutput(panel.id, sessionId, data.toString(), 'stderr');
      });
      
      // Handle process exit
      childProcess.on('exit', (code) => {
        this.handleProcessExit(panel.id, sessionId, code);
      });
      
      // Handle process error
      childProcess.on('error', (error) => {
        this.handleOutput(panel.id, sessionId, `Process error: ${error.message}`, 'stderr');
        this.handleProcessExit(panel.id, sessionId, 1);
      });
    } else {
      // Process failed to start
      this.handleOutput(panel.id, sessionId, 'Failed to start process', 'stderr');
      this.handleProcessExit(panel.id, sessionId, 1);
    }
  }
  
  /**
   * Get all descendant PIDs of a process recursively
   * @param parentPid The parent process ID
   * @returns Array of all descendant PIDs
   */
  private getAllDescendantPids(parentPid: number): number[] {
    const descendants: number[] = [];
    const platform = os.platform();
    
    try {
      if (platform === 'win32') {
        // On Windows, use wmic to get process tree
        const output = execSync(`wmic process where (ParentProcessId=${parentPid}) get ProcessId`, { encoding: 'utf8' });
        const lines = output.split('\n').filter(line => line.trim());
        for (let i = 1; i < lines.length; i++) { // Skip header
          const pid = parseInt(lines[i].trim());
          if (!isNaN(pid)) {
            descendants.push(pid);
            // Recursively get children of this process
            descendants.push(...this.getAllDescendantPids(pid));
          }
        }
      } else {
        // On Unix-like systems, we need different commands for macOS vs Linux
        try {
          // Try Linux-style first (with --ppid)
          const output = execSync(`ps -o pid= --ppid ${parentPid}`, { encoding: 'utf8' });
          const pids = output.split('\n')
            .map(line => parseInt(line.trim()))
            .filter(pid => !isNaN(pid));
          
          for (const pid of pids) {
            descendants.push(pid);
            // Recursively get children of this process
            descendants.push(...this.getAllDescendantPids(pid));
          }
        } catch {
          // If that fails, try macOS/BSD style
          try {
            // Get all processes with their parent PIDs, then filter
            const output = execSync(`ps -eo pid,ppid | awk '$2==${parentPid} {print $1}'`, { encoding: 'utf8' });
            const pids = output.split('\n')
              .map(line => parseInt(line.trim()))
              .filter(pid => !isNaN(pid));
            
            for (const pid of pids) {
              descendants.push(pid);
              // Recursively get children of this process
              descendants.push(...this.getAllDescendantPids(pid));
            }
          } catch {
            // Could not find children
          }
        }
      }
    } catch {
      // Command might fail if no children exist, which is fine
    }
    
    return descendants;
  }

  /**
   * Stop a running script and ensure all child processes are terminated.
   * This method uses multiple approaches to ensure complete cleanup:
   * 1. Gets all descendant PIDs recursively before killing
   * 2. Uses platform-specific commands (taskkill on Windows, kill on Unix)
   * 3. Kills the process group (Unix) or process tree (Windows)
   * 4. Kills individual descendant processes as a fallback
   * 5. Uses graceful SIGTERM first, then forceful SIGKILL
   */
  async stopScript(panelId: string): Promise<void> {
    const childProcess = this.activeProcesses.get(panelId);
    if (!childProcess || !childProcess.pid) {
      this.activeProcesses.delete(panelId);
      return;
    }
    
    const pid = childProcess.pid;
    const platform = os.platform();
    
    // Immediately remove from active processes to prevent new output
    this.activeProcesses.delete(panelId);
    
    try {
      // First, get all descendant PIDs before we start killing
      const descendantPids = this.getAllDescendantPids(pid);
      
      if (platform === 'win32') {
        // On Windows, use taskkill to terminate the process tree
        await new Promise<void>((resolve) => {
          exec(`taskkill /F /T /PID ${pid}`, (error) => {
            if (error) {
              console.warn(`Error killing Windows process tree: ${error.message}`);
              
              // Fallback: kill individual processes
              try {
                childProcess.kill('SIGKILL');
              } catch (killError) {
                console.warn('Fallback kill failed:', killError);
              }
              
              // Kill descendants individually
              let processedCount = 0;
              const totalDescendants = descendantPids.length;
              
              if (totalDescendants === 0) {
                resolve();
                return;
              }
              
              descendantPids.forEach(descPid => {
                exec(`taskkill /F /PID ${descPid}`, () => {
                  processedCount++;
                  if (processedCount === totalDescendants) {
                    resolve();
                  }
                });
              });
            } else {
              console.log(`Successfully killed Windows process tree ${pid}`);
              resolve();
            }
          });
        });
      } else {
        // On Unix-like systems (macOS, Linux)
        // When using shell: true, the actual script runs as children of the shell
        // We need to kill the shell AND all its descendants
        
        // Build a list of all PIDs to kill (main + descendants)
        const allPids = [pid, ...descendantPids];
        
        // Try to kill each PID with SIGKILL
        for (const targetPid of allPids) {
          try {
            process.kill(targetPid, 'SIGKILL');
          } catch {
            // Process might already be dead or inaccessible
          }
        }
        
        // Use shell command as ultimate fallback
        // This uses kill -9 which cannot be caught or ignored
        const killCmd = `kill -9 ${allPids.join(' ')} 2>/dev/null; pkill -9 -P ${pid} 2>/dev/null`;
        await new Promise<void>((resolve) => {
          exec(killCmd, () => {
            // Ignore errors - processes might already be dead
            resolve();
          });
        });
      }
    } catch (error) {
      console.error('Error killing process tree:', error);
    }
  }
  
  /**
   * Handle process output
   */
  private handleOutput(panelId: string, sessionId: string, content: string, type: 'stdout' | 'stderr'): void {
    // Add to session logs
    const level = type === 'stderr' ? 'error' : 'info';
    addSessionLog(sessionId, level, content, 'Script');
    
    // Emit output event
    this.sendRendererEvent('panel:event', {
      type: 'process:output',
      source: {
        panelId,
        panelType: 'logs',
        sessionId
      },
      data: { content, type },
      timestamp: new Date().toISOString()
    });

    // Also send logs-specific output event for the panel
    this.sendRendererEvent('logs:output', {
      panelId,
      content,
      type
    });
  }
  
  /**
   * Handle process exit
   */
  private async handleProcessExit(panelId: string, sessionId: string, code: number | null): Promise<void> {
    // Remove from active processes
    this.activeProcesses.delete(panelId);

    // Track script execution analytics
    const startTime = this.scriptStartTimes.get(panelId);
    if (startTime && this.analyticsManager) {
      const duration = (Date.now() - startTime) / 1000; // Convert to seconds
      const success = code === 0;

      this.analyticsManager.track('run_script_executed', {
        success,
        duration_seconds: this.analyticsManager.categorizeDuration(duration),
      });

      // Clean up start time
      this.scriptStartTimes.delete(panelId);
    }

    // Update panel state
    const panel = await panelManager.getPanel(panelId);
    if (panel) {
      const currentState = getLogsPanelState(panel);
      await panelManager.updatePanel(panelId, {
        state: {
          ...panel.state,
          customState: {
            ...currentState,
            isRunning: false,
            endTime: new Date().toISOString(),
            exitCode: code ?? undefined
          }
        }
      });
    }

    // Emit process ended event
    this.sendRendererEvent('panel:event', {
      type: 'process:ended',
      source: {
        panelId,
        panelType: 'logs',
        sessionId
      },
      data: { exitCode: code },
      timestamp: new Date().toISOString()
    });

    // Also send specific event for the panel
    this.sendRendererEvent('process:ended', {
      panelId,
      exitCode: code
    });

    // Add final log entry
    const message = code === 0
      ? 'Process completed successfully'
      : `Process exited with code ${code}`;
    addSessionLog(sessionId, code === 0 ? 'info' : 'error', message, 'Script');
  }
  
  /**
   * Check if a logs panel is running for a session
   */
  async isRunning(sessionId: string): Promise<boolean> {
    const panels = await panelManager.getPanelsForSession(sessionId);
    const logsPanel = panels.find((p: ToolPanel) => p.type === 'logs');
    
    if (!logsPanel) return false;
    
    const state = getLogsPanelState(logsPanel);
    return state?.isRunning || false;
  }
  
  /**
   * Get the running process for a session's logs panel
   */
  async getRunningProcess(sessionId: string): Promise<ChildProcess | undefined> {
    const panels = await panelManager.getPanelsForSession(sessionId);
    const logsPanel = panels.find((p: ToolPanel) => p.type === 'logs');
    
    if (!logsPanel) return undefined;
    
    return this.activeProcesses.get(logsPanel.id);
  }
  
  /**
   * Cleanup all running processes
   */
  async cleanup(): Promise<void> {
    // Stop all running processes
    for (const panelId of this.activeProcesses.keys()) {
      await this.stopScript(panelId);
    }
    this.activeProcesses.clear();
  }
}

export const logsManager = LogsManager.getInstance();
