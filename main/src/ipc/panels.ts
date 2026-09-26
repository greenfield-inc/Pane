import { clipboard } from 'electron';
import type { IpcMain } from 'electron';
import { existsSync, readdirSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { getPaneWebviewContextMap } from '../core/runtime';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { databaseService } from '../services/database';
import { CreatePanelRequest, PanelEventType, SessionPanelLayout, ToolPanel, type PanelLayoutNode } from '../../../shared/types/panels';
import type { AppServices } from './types';
import type { PanelAgentStatusEvent } from '../../../shared/types/agentStatus';
import { PANE_CHAT_SESSION_ID } from '../../../shared/types/paneChat';
import { getAppSubdirectory } from '../utils/appDirectory';
import { sanitizeTerminalOutput } from '../utils/terminalOutputSanitizer';
import { getWSLHome, linuxToUNCPath, posixJoin, windowsPathToWSLMount } from '../utils/wslUtils';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';

const execFileAsync = promisify(execFile);

const panelLayoutNodeSchema: BoundarySchema<PanelLayoutNode> = {
  decode(cursor) {
    return boundary.union(
      boundary.object({
        type: boundary.literal('group'),
        id: boundary.string,
        panelIds: boundary.array(boundary.string),
        activePanelId: boundary.nullable(boundary.string),
      }),
      boundary.object({
        type: boundary.literal('split'),
        id: boundary.string,
        direction: boundary.enumeration('row', 'column'),
        children: boundary.array(panelLayoutNodeSchema),
        sizes: boundary.array(boundary.number),
      }),
    ).decode(cursor);
  },
};

const sessionPanelLayoutSchema: BoundarySchema<SessionPanelLayout> = boundary.object({
  version: boundary.literal(1),
  root: panelLayoutNodeSchema,
  focusedGroupId: boundary.optional(boundary.string),
  zoomedGroupId: boundary.optional(boundary.nullable(boundary.string)),
});

/**
 * Check if a session's project is WSL-enabled and convert path if needed.
 */
function resolveImagePathForSession(filePath: string, sessionId: string): string {
  if (process.platform !== 'win32') return filePath;
  const session = databaseService.getSession(sessionId);
  if (!session?.project_id) return filePath;
  const project = databaseService.getProject(session.project_id);
  if (!project?.wsl_enabled) return filePath;
  return windowsPathToWSLMount(filePath);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:\\/.test(value);
}

function resolveTerminalInitializationCwd(
  panel: ToolPanel,
  requestedCwd?: string,
): string {
  const sessionId = panel.sessionId;
  const session = sessionId ? databaseService.getSession(sessionId) : null;
  const sessionWorktreePath = session?.worktree_path;
  const project = session?.project_id ? databaseService.getProject(session.project_id) : null;
  const fallbackCwd = process.cwd();

  if (!sessionWorktreePath) {
    return requestedCwd || fallbackCwd;
  }

  if (!requestedCwd || requestedCwd === fallbackCwd) {
    return sessionWorktreePath;
  }

  if (project?.wsl_enabled && isWindowsAbsolutePath(requestedCwd)) {
    console.warn(
      `[IPC] Ignoring Windows cwd for WSL terminal panel ${panel.id}; using session worktree ${sessionWorktreePath}`,
    );
    return sessionWorktreePath;
  }

  return requestedCwd;
}

/** Scrollback for a panel whose terminal is not live: read from panel_buffers, never from panel state. */
function readPersistedScrollback(panelId: string): string | null {
  return databaseService.getPanelBuffers(panelId)?.scrollback ?? null;
}

async function readCleanTerminalScrollback(panelId: string, lines: number): Promise<string | null> {
  const liveScrollback = await terminalPanelManager.getCleanTerminalScrollback(panelId, lines);
  if (liveScrollback !== null) return liveScrollback;

  const persistedScrollback = readPersistedScrollback(panelId);
  if (persistedScrollback === null || persistedScrollback === '') return null;

  return sanitizeTerminalOutput(persistedScrollback).split('\n').slice(-lines).join('\n');
}

/**
 * Save file bytes for a session and return the path to pass to the CLI tool.
 *
 * For WSL-enabled sessions on Windows, writes directly to WSL's ~/.pane/<subdir>/
 * via the \\wsl.localhost UNC share and returns the native Linux path
 * (/home/<user>/.pane/<subdir>/<filename>). Claude Code CLI running inside WSL
 * can read this directly, unlike a /mnt/c/... DrvFs path which it silently
 * rejects when trying to attach pasted images.
 *
 * For native Mac/Linux, or WSL sessions where the UNC write fails, falls back
 * to writing to the host's .pane/<subdir>/ via getAppSubdirectory() and returns
 * the result of resolveImagePathForSession() — same behavior as before this
 * helper existed.
 */
async function saveFileForSession(
  sessionId: string,
  subdir: 'images' | 'files',
  filename: string,
  bytes: Buffer,
): Promise<string> {
  // Only attempt WSL-native save on Windows hosts with a WSL-enabled project.
  if (process.platform === 'win32') {
    const session = databaseService.getSession(sessionId);
    const projectId = session?.project_id;
    const project = projectId ? databaseService.getProject(projectId) : null;
    if (project?.wsl_enabled && project.wsl_distribution) {
      const distro = project.wsl_distribution;
      try {
        const wslHome = await getWSLHome(distro);
        if (wslHome) {
          const linuxDir = posixJoin(wslHome, '.pane', subdir);
          const linuxPath = posixJoin(linuxDir, filename);
          const uncDir = linuxToUNCPath(linuxDir, distro);
          const uncPath = linuxToUNCPath(linuxPath, distro);
          if (!existsSync(uncDir)) {
            await fs.mkdir(uncDir, { recursive: true });
          }
          await fs.writeFile(uncPath, bytes);
          return linuxPath;
        }
      } catch (err) {
        // Fall through to native-host save below — no worse than the old behavior.
        console.warn(`[saveFileForSession] WSL-native save failed for ${distro}, falling back:`, err);
      }
    }
  }

  // Fallback: save to the host's .pane/<subdir>/ and let resolveImagePathForSession
  // convert to /mnt/c/... if the session happens to be WSL-enabled.
  const hostDir = getAppSubdirectory(subdir);
  if (!existsSync(hostDir)) {
    await fs.mkdir(hostDir, { recursive: true });
  }
  const hostPath = path.join(hostDir, filename);
  await fs.writeFile(hostPath, bytes);
  return resolveImagePathForSession(hostPath, sessionId);
}

// In-memory cache: sessionId -> imageCount for terminal image paste
// Initialized from disk on first paste per session to survive app restarts
export const sessionImageCounters = new Map<string, number>();

// MIME type to file extension mapping
interface MimeExtensionLookup {
  [mimeType: string]: string;
}

const MIME_EXTENSIONS: MimeExtensionLookup = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

// Cache WSL detection result
let isWSLCached: boolean | null = null;

async function isWSL(): Promise<boolean> {
  if (isWSLCached !== null) return isWSLCached;
  try {
    const { stdout } = await execFileAsync('uname', ['-r']);
    isWSLCached = stdout.toLowerCase().includes('microsoft');
  } catch {
    isWSLCached = false;
  }
  return isWSLCached;
}

// Find powershell.exe from WSL
async function findPowerShell(): Promise<string | null> {
  const candidates = [
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fallback: try PATH
  try {
    await execFileAsync('which', ['powershell.exe']);
    return 'powershell.exe';
  } catch {
    return null;
  }
}

/**
 * Try to read an image from the system clipboard using platform-specific methods.
 * This is the fallback for when the browser's clipboardData.items doesn't contain
 * image data (e.g. on WSL where the Windows clipboard isn't bridged).
 * Returns the saved file path, or null if no image was found.
 */
async function readClipboardImageFallback(sessionId: string): Promise<{ filePath: string; imageNumber: number } | null> {
  const imagesDir = getAppSubdirectory('images');
  if (!existsSync(imagesDir)) {
    await fs.mkdir(imagesDir, { recursive: true });
  }

  // Initialize counter from existing files on disk if not cached
  if (!sessionImageCounters.has(sessionId)) {
    const existing = readdirSync(imagesDir)
      .filter(f => f.startsWith(`${sessionId}_`));
    sessionImageCounters.set(sessionId, existing.length);
  }

  const count = (sessionImageCounters.get(sessionId) ?? 0) + 1;
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 9);

  // Extension is determined per-platform; default to png for WSL/macOS/Windows
  let extension = 'png';

  const buildFilePath = () => {
    const filename = `${sessionId}_${count}_${timestamp}_${randomStr}.${extension}`;
    return path.join(imagesDir, filename);
  };

  const wsl = await isWSL();

  if (wsl) {
    // WSL: Try Electron's clipboard.readImage() first (instant, works when
    // WSLg clipboard sync succeeds), then fall back to PowerShell.
    const electronImg = clipboard.readImage();
    if (!electronImg.isEmpty()) {
      await fs.writeFile(buildFilePath(), electronImg.toPNG());
    } else {
      // Electron clipboard empty — fall back to PowerShell to read Windows clipboard
      const ps = await findPowerShell();
      if (!ps) {
        console.warn('[ClipboardFallback] PowerShell not found on WSL');
        return null;
      }

      const filePath = buildFilePath();

      // Convert WSL path to Windows path for PowerShell
      let winPath: string;
      try {
        const { stdout } = await execFileAsync('wslpath', ['-w', filePath]);
        winPath = stdout.trim();
      } catch {
        console.warn('[ClipboardFallback] wslpath failed');
        return null;
      }

      // Escape for PowerShell single-quoted string: double any apostrophes
      const escapedPath = winPath.replace(/'/g, "''");
      const psCommand = `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img -ne $null) { $img.Save('${escapedPath}'); Write-Output 'OK' } else { Write-Output 'NO_IMAGE' }`;

      try {
        const { stdout } = await execFileAsync(ps, ['-NoProfile', '-NonInteractive', '-Command', psCommand], { timeout: 15000 });
        if (stdout.trim() !== 'OK') {
          return null;
        }
      } catch (err) {
        console.warn('[ClipboardFallback] PowerShell clipboard read failed:', err);
        return null;
      }
    }
  } else if (process.platform === 'darwin') {
    // macOS: Use Electron's clipboard.readImage()
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    await fs.writeFile(buildFilePath(), img.toPNG());
  } else if (process.platform === 'win32') {
    // Native Windows: Use Electron's clipboard.readImage().
    // Route through saveFileForSession so WSL-enabled sessions get the image
    // written to the WSL distro's ~/.pane/images/ — Claude CLI inside WSL can
    // read that path directly, unlike a /mnt/c/... DrvFs fallback.
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    const bytes = img.toPNG();
    if (bytes.length > 10 * 1024 * 1024) {
      throw new Error('Image too large');
    }
    const filename = `${sessionId}_${count}_${timestamp}_${randomStr}.${extension}`;
    const resolvedPath = await saveFileForSession(sessionId, 'images', filename, bytes);
    sessionImageCounters.set(sessionId, count);
    return { filePath: resolvedPath, imageNumber: count };
  } else {
    // Linux: Try xclip — detect actual MIME type from clipboard
    try {
      const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
      const targets = stdout.split('\n').map(t => t.trim());
      // Prefer png, then jpeg, then any image type
      const preferredOrder = ['image/png', 'image/jpeg', 'image/bmp', 'image/webp', 'image/gif'];
      const imageTarget = preferredOrder.find(t => targets.includes(t))
        ?? targets.find(t => t.startsWith('image/'));
      if (!imageTarget) {
        return null;
      }
      // Set file extension based on actual clipboard MIME type
      extension = MIME_EXTENSIONS[imageTarget] ?? imageTarget.split('/')[1]?.replace(/[^a-z0-9]/g, '') ?? 'png';
      // Read image data as binary
      const imgData = await new Promise<Buffer>((resolve, reject) => {
        const proc = execFile('xclip', ['-selection', 'clipboard', '-t', imageTarget, '-o']);
        const chunks: Buffer[] = [];
        proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
        proc.on('close', (code) => {
          if (code === 0) resolve(Buffer.concat(chunks));
          else reject(new Error(`xclip exited with code ${code}`));
        });
        proc.on('error', reject);
      });
      await fs.writeFile(buildFilePath(), imgData);
    } catch {
      return null;
    }
  }

  const filePath = buildFilePath();

  // Verify file was actually created and has content
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === 0) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    // Backend size validation (10MB limit)
    if (stat.size > 10 * 1024 * 1024) {
      await fs.unlink(filePath).catch(() => {});
      throw new Error('Image too large');
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'Image too large') throw err;
    return null;
  }

  // Commit the counter increment only after successful save
  sessionImageCounters.set(sessionId, count);

  return { filePath: resolveImagePathForSession(filePath, sessionId), imageNumber: count };
}

const DAEMON_PANEL_CHANNELS = [
  'panels:create',
  'panels:delete',
  'panels:update',
  'panels:list',
  'panels:agent-statuses',
  'panels:set-active',
  'panels:getActive',
  'panels:get-layout',
  'panels:set-layout',
  'panels:initialize',
  'panels:checkInitialized',
  'panels:emitEvent',
  'panels:resize-terminal',
  'panels:send-terminal-input',
  'panels:shouldAutoCreate',
  'terminal:input',
  'terminal:resize',
  'terminal:getState',
  'terminal:saveState',
  'terminal:saveSnapshot',
  'terminal:clearScrollback',
  'terminal:setVisibility',
  'terminal:ack',
  'terminal:resetFlowControl',
  'terminal:getAltScreenState',
  'terminal:getScrollbackClean',
  'terminal:paste-image',
  'terminal:save-scrollback',
  'terminal:paste-file',
] as const;

export function registerPanelHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
) {
  // Panel CRUD operations
  commandRegistry.register('panels:create', async (request: CreatePanelRequest) => {
    try {
      const panel = await panelManager.createPanel(request);
      return { success: true, data: panel };
    } catch (error) {
      console.error('[IPC] Failed to create panel:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  
  commandRegistry.register('panels:delete', async (panelId: string) => {
    try {
      // Clean up terminal process if it's a terminal panel
      const panel = panelManager.getPanel(panelId);
      if (panel?.type === 'terminal') {
        await terminalPanelManager.destroyTerminal(panelId, { saveState: false });
      }

      await panelManager.deletePanel(panelId);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to delete panel:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  
  commandRegistry.register('panels:update', async (panelId: string, updates: Partial<ToolPanel>) => {
    try {
      // Track panel rename if title is being updated
      if (updates.title) {
        const panel = panelManager.getPanel(panelId);
        if (panel && panel.title !== updates.title && services.analyticsManager) {
          services.analyticsManager.track('panel_renamed', {
            panel_type: panel.type
          });
        }
      }

      const result = await panelManager.updatePanel(panelId, updates);
      return { success: true, data: result };
    } catch (error) {
      console.error('[IPC] Failed to update panel:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  
  // Renderer baseline includes hidden Pane Chat, which the public workspace
  // snapshot deliberately omits. Read the same authoritative monitor state.
  commandRegistry.register('panels:agent-statuses', () => {
    const sessionIds = new Set(services.sessionManager.getAllSessions()
      .filter(session => !session.archived)
      .map(session => session.id));
    sessionIds.add(PANE_CHAT_SESSION_ID);
    const statuses: PanelAgentStatusEvent[] = [];
    for (const sessionId of sessionIds) {
      for (const panel of panelManager.getPanelsForSession(sessionId)) {
        if (panel.type !== 'terminal') continue;
        statuses.push({
          panelId: panel.id,
          sessionId,
          state: terminalPanelManager.getAgentStatus(panel.id) ?? 'unknown',
          reason: null,
        });
      }
    }
    return { success: true, data: statuses };
  });

  commandRegistry.register('panels:list', async (sessionId: string) => {
    try {
      const panels = panelManager.getPanelsForSession(sessionId);
      return { success: true, data: panels };
    } catch (error) {
      console.error('[IPC] Failed to list panels:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  
  commandRegistry.register('panels:set-active', async (sessionId: string, panelId: string) => {
    try {
      await panelManager.setActivePanel(sessionId, panelId);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to set active panel:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  
  commandRegistry.register('panels:getActive', async (sessionId: string) => {
    return databaseService.getActivePanel(sessionId);
  });

  // Layout get/set for split tab groups
  commandRegistry.register('panels:get-layout', async (sessionId: string) => {
    try {
      const raw = databaseService.getSessionPanelLayout(sessionId);
      if (!raw) return { success: true, data: null };
      try {
        const parsed = decodeBoundary(JSON.parse(raw), sessionPanelLayoutSchema);
        return { success: true, data: parsed };
      } catch {
        // Malformed JSON should never brick a session
        console.warn('[IPC] Corrupt panel_layout JSON for session', sessionId);
        return { success: true, data: null };
      }
    } catch (error) {
      console.error('[IPC] Failed to get panel layout:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  commandRegistry.register('panels:set-layout', async (sessionId: string, layout: SessionPanelLayout | null) => {
    try {
      if (layout === null) {
        databaseService.setSessionPanelLayout(sessionId, null);
        return { success: true };
      }

      // Server-side validation: strip panel ids that don't exist in this session
      const livePanels = databaseService.getPanelsForSession(sessionId);
      const liveIds = new Set(livePanels.map(p => p.id));

      function stripUnknownIds(node: SessionPanelLayout['root']): SessionPanelLayout['root'] | null {
        if (node.type === 'group') {
          const filtered = node.panelIds.filter(id => liveIds.has(id));
          if (filtered.length === 0) return null;
          return {
            ...node,
            panelIds: filtered,
            activePanelId: filtered.includes(node.activePanelId ?? '') ? node.activePanelId : filtered[0],
          };
        }
        // Split node: recurse into children
        const children: SessionPanelLayout['root'][] = [];
        const sizes: number[] = [];
        for (let i = 0; i < node.children.length; i++) {
          const cleaned = stripUnknownIds(node.children[i]);
          if (cleaned) {
            children.push(cleaned);
            sizes.push(node.sizes[i] ?? 1);
          }
        }
        if (children.length === 0) return null;
        if (children.length === 1) return children[0];
        return { ...node, children, sizes };
      }

      const cleanedRoot = stripUnknownIds(layout.root);
      if (!cleanedRoot) {
        databaseService.setSessionPanelLayout(sessionId, null);
        return { success: true };
      }

      const cleanedLayout: SessionPanelLayout = {
        ...layout,
        root: cleanedRoot,
      };
      databaseService.setSessionPanelLayout(sessionId, JSON.stringify(cleanedLayout));
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to set panel layout:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Panel initialization (lazy loading)
  commandRegistry.register('panels:initialize', async (panelId: string, options?: { cwd?: string; sessionId?: string; cols?: number; rows?: number }) => {

    const panel = panelManager.getPanel(panelId);
    if (!panel) {
      throw new Error(`Panel ${panelId} not found`);
    }

    // Mark panel as viewed
    if (!panel.state.hasBeenViewed) {
      panel.state.hasBeenViewed = true;
      await panelManager.updatePanel(panelId, { state: panel.state });
    }

    // Initialize based on panel type
    if (panel.type === 'terminal') {
      const cwd = resolveTerminalInitializationCwd(panel, options?.cwd);

      // Get WSL context from project for terminal shell spawning
      let wslContext = null;
      if (panel.sessionId) {
        const ctx = services.sessionManager.getProjectContext(panel.sessionId);
        if (ctx) {
          // Extract wslContext from CommandRunner for terminal spawning
          wslContext = ctx.commandRunner.wslContext;
        }
      }

      const initialDimensions = (options?.cols && options?.rows) ? { cols: options.cols, rows: options.rows } : undefined;
      await terminalPanelManager.initializeTerminal(panel, cwd, wslContext, undefined, initialDimensions);
    }

    return true;
  });
  
  commandRegistry.register('panels:checkInitialized', async (panelId: string) => {
    const panel = panelManager.getPanel(panelId);
    if (!panel) return false;

    if (panel.type === 'terminal') {
      return terminalPanelManager.isTerminalInitialized(panelId);
    }

    if (panel.type === 'diff') {
      // Diff panels don't have background processes, so they're always "initialized"
      return true;
    }

    // Explorer panels don't need initialization
    if (panel.type === 'explorer' || panel.type === 'editor') {
      return true;
    }

    if (panel.type === 'browser') {
      return true;
    }

    return false;
  });
  
  // Event handlers
  commandRegistry.register('panels:emitEvent', async (panelId: string, eventType: PanelEventType, data: PaneCommandValue) => {
    return panelManager.emitPanelEvent(panelId, eventType, data);
  });

  
  // Panel-specific terminal handlers (called via panels: namespace from frontend)
  commandRegistry.register('panels:resize-terminal', async (panelId: string, cols: number, rows: number) => {
    try {
      await terminalPanelManager.resizeTerminal(panelId, cols, rows);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to resize terminal:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  
  commandRegistry.register('panels:send-terminal-input', async (panelId: string, data: string) => {
    try {
      await terminalPanelManager.writeToTerminal(panelId, data);
      return { success: true };
    } catch (error) {
      console.error('[IPC] Failed to send terminal input:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  
  // Note: Panel output handlers (get-output, get-conversation-messages, get-json-messages, get-prompts, continue)
  // are implemented in session.ts as they need access to sessionManager methods
  
  // Terminal-specific handlers (internal use)
  commandRegistry.register('terminal:input', async (panelId: string, data: string) => {
    return terminalPanelManager.writeToTerminal(panelId, data);
  });
  
  commandRegistry.register('terminal:resize', async (
    panelId: string,
    cols: number,
    rows: number,
    options?: { force?: boolean },
  ) => {
    return terminalPanelManager.resizeTerminal(panelId, cols, rows, options);
  });
  
  commandRegistry.register('terminal:getState', async (panelId: string) => {
    return terminalPanelManager.getTerminalState(panelId);
  });

  commandRegistry.register('terminal:saveState', async (panelId: string) => {
    return terminalPanelManager.saveTerminalState(panelId);
  });

  commandRegistry.register('terminal:saveSnapshot', async (panelId: string, serializedData: string) => {
    try {
      terminalPanelManager.saveSerializedSnapshot(panelId, serializedData);
      return { success: true };
    } catch (error) {
      console.error('[terminal:saveSnapshot] Failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  commandRegistry.register('terminal:clearScrollback', async (panelId: string) => {
    try {
      await terminalPanelManager.clearTerminalScrollback(panelId);
      return { success: true };
    } catch (error) {
      console.error('[terminal:clearScrollback] Failed:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Renderer tells main when a terminal panel becomes (in)visible so PTY
  // output cadence can drop to OUTPUT_BATCH_INTERVAL_HIDDEN while hidden.
  // No-op when the panel's PTY isn't in the map (pre-init / post-destroy).
  commandRegistry.register('terminal:setVisibility', async (panelId: string, isVisible: boolean, viewerId?: string) => {
    const scopedViewerId = viewerId?.includes(':')
      ? viewerId
      : viewerId
        ? `local:${viewerId}`
        : undefined;
    terminalPanelManager.setVisibility(panelId, !!isVisible, scopedViewerId);
  });

  commandRegistry.register('terminal:ack', async (panelId: string, bytesConsumed: number) => {
    terminalPanelManager.acknowledgeBytes(panelId, bytesConsumed);
  });

  // Reset flow control state (for recovering from stuck terminals)
  commandRegistry.register('terminal:resetFlowControl', async (panelId: string) => {
    terminalPanelManager.resetFlowControl(panelId);
  });

  // Get alternate screen state for TUI detection on panel mount
  commandRegistry.register('terminal:getAltScreenState', async (panelId: string) => {
    return terminalPanelManager.getAltScreenState(panelId);
  });

  commandRegistry.register('terminal:getScrollbackClean', async (panelId: string, lines: number) => {
    try {
      const content = await readCleanTerminalScrollback(panelId, lines);
      if (content === null) {
        return { success: false, error: `No scrollback available for panel ${panelId}` };
      }

      const panel = panelManager.getPanel(panelId);
      const panelTitle = panel?.title ?? panelId;
      return { success: true, data: { content, lineCount: content.split('\n').length, panelTitle } };
    } catch (error) {
      console.error('[IPC] Failed to get clean scrollback:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Save a pasted image to the appropriate .pane/images/ and return the file path with image number.
  // For WSL-enabled sessions, the file is written to the WSL distro's ~/.pane/images/ so
  // Claude CLI (running inside WSL) can read it at a native Linux path instead of /mnt/c/...
  commandRegistry.register('terminal:paste-image', async (
    _panelId: string,
    sessionId: string,
    dataUrl: string,
    mimeType: string
  ) => {
    // Initialize counter from existing files on disk if not cached.
    // Note: this counts files in the host-side .pane/images/ for backwards compat —
    // it's just a counter for UI ordering, not a strict inventory of saved files.
    const hostImagesDir = getAppSubdirectory('images');
    if (!existsSync(hostImagesDir)) {
      await fs.mkdir(hostImagesDir, { recursive: true });
    }
    if (!sessionImageCounters.has(sessionId)) {
      const existing = readdirSync(hostImagesDir)
        .filter(f => f.startsWith(`${sessionId}_`));
      sessionImageCounters.set(sessionId, existing.length);
    }

    // Increment counter
    const count = (sessionImageCounters.get(sessionId) ?? 0) + 1;

    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 9);
    const extension = MIME_EXTENSIONS[mimeType] ?? 'png';
    const filename = `${sessionId}_${count}_${timestamp}_${randomStr}.${extension}`;

    // Decode base64
    const base64Data = dataUrl.split(',')[1];
    if (!base64Data) {
      throw new Error('Invalid image data URL');
    }
    const buffer = Buffer.from(base64Data, 'base64');

    // Backend size validation: same 50MB cap as terminal:paste-file, since this
    // handler also just saves the bytes to disk and returns the resolved path
    if (buffer.length > 50 * 1024 * 1024) {
      throw new Error('Image too large (max 50 MB)');
    }

    const resolvedPath = await saveFileForSession(sessionId, 'images', filename, buffer);

    // Commit counter only after successful save
    sessionImageCounters.set(sessionId, count);

    return { filePath: resolvedPath, imageNumber: count };
  });

  // Fallback clipboard image check for platforms where browser clipboardData
  // doesn't contain image data (WSL, some Linux configs).
  // Reads system clipboard using platform-specific tools.
  // This remains adapter-side because the source clipboard belongs to the local client.
  ipcMain.handle('terminal:clipboard-paste-image', async (_, sessionId: string) => {
    try {
      return await readClipboardImageFallback(sessionId);
    } catch (err) {
      console.error('[ClipboardFallback] Failed:', err);
      if (err instanceof Error && err.message === 'Image too large') {
        throw err;
      }
      return null;
    }
  });

  // Save terminal scrollback to ~/.pane/files/ as a .txt and return the resolved path
  commandRegistry.register('terminal:save-scrollback', async (
    panelId: string,
    sessionId: string,
    lines: number,
  ) => {
    try {
      const content = await readCleanTerminalScrollback(panelId, lines);
      if (content === null || content === '') {
        return { success: false, error: `No scrollback available for panel ${panelId}` };
      }

      const panel = panelManager.getPanel(panelId);
      const panelTitle = panel?.title ?? panelId;

      const timestamp = Date.now();
      const randomStr = Math.random().toString(36).substring(2, 9);
      const filename = `${sessionId}_scrollback_${timestamp}_${randomStr}.txt`;

      // Save to .pane/files/ — routes to WSL-native path for WSL sessions so
      // Claude CLI inside WSL can read the file at a native Linux path.
      const resolvedPath = await saveFileForSession(sessionId, 'files', filename, Buffer.from(content, 'utf-8'));
      return { success: true, data: { filePath: resolvedPath, lineCount: content.split('\n').length, panelTitle } };
    } catch (error) {
      console.error('[IPC] Failed to save scrollback:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Save a dropped file (any type) to .pane/files/ and return the resolved path
  commandRegistry.register('terminal:paste-file', async (
    sessionId: string,
    dataUrl: string,
    originalFileName: string
  ) => {
    // Derive extension from original filename
    const extMatch = originalFileName.match(/\.([a-zA-Z0-9]+)$/);
    const extension = extMatch ? extMatch[1].toLowerCase() : 'bin';

    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 9);
    const filename = `${sessionId}_${timestamp}_${randomStr}.${extension}`;

    const base64Data = dataUrl.split(',')[1];
    if (!base64Data) {
      throw new Error('Invalid data URL');
    }
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.length > 50 * 1024 * 1024) {
      throw new Error('File too large (max 50 MB)');
    }

    const resolvedPath = await saveFileForSession(sessionId, 'files', filename, buffer);
    return { filePath: resolvedPath };
  });

  // Check if a panel type should be auto-created (not previously closed by user)
  commandRegistry.register('panels:shouldAutoCreate', async (sessionId: string, panelType: string) => {
    return panelManager.shouldAutoCreatePanel(sessionId, panelType);
  });

  // Register a webview's panel/session context so the did-attach-webview popup handler
  // (in index.ts) can route popups to the correct browser panel.
  ipcMain.handle('browser-panel:register-webview', async (_, wcId: number, panelId: string, sessionId: string) => {
    getPaneWebviewContextMap().set(wcId, { panelId, sessionId });
    return { success: true };
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_PANEL_CHANNELS);
}
