import React, { useCallback, memo, useState, useRef, useEffect, useMemo } from 'react';
import { Plus, X, Terminal, GitBranch, FileCode, FileDiff, FileText, BarChart3, PanelRight, FolderTree, TerminalSquare, Play, Globe, Pencil } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '../../utils/cn';
import { useHotkey } from '../../hooks/useHotkey';
import { PanelTabBarProps, PanelCreateOptions } from '../../types/panelComponents';
import { ToolPanel, ToolPanelType, PANEL_CAPABILITIES } from '../../../../shared/types/panels';
import { useSession } from '../../contexts/SessionContext';
import { useConfigStore } from '../../stores/configStore';
import { formatKeyDisplay } from '../../utils/hotkeyUtils';
import { useHotkeyStore } from '../../stores/hotkeyStore';
import { Tooltip } from '../ui/Tooltip';
import { useTitleBarSlotStore } from '../../stores/titleBarSlotStore';
import { editorPanelState } from '../../services/openFileInEditor';
import { Kbd } from '../ui/Kbd';
import { CLI_BRAND_ICONS, getCliBrandIcon } from '../ui/brandIconRegistry';
import { visibleAgentPresets } from '../../utils/agentPresets';
import { PanelTabStrip } from './PanelTabStrip';
import { CustomCommandForm } from './CustomCommandForm';
import type { WorktreeFileSyncEntry } from '../../../../shared/types/worktreeFileSync';

const ADD_TOOL_MENU_WIDTH = 280;
const ADD_TOOL_MENU_VIEWPORT_MARGIN = 8;
const MAX_CUSTOM_COMMAND_LABEL_LENGTH = 18;

function truncateCustomCommandLabel(label: string): string {
  if (label.length <= MAX_CUSTOM_COMMAND_LABEL_LENGTH) return label;
  return `${label.slice(0, MAX_CUSTOM_COMMAND_LABEL_LENGTH - 3)}...`;
}

// Build prompt for setting up intelligent dev command — adapts based on Worktree File Sync config
function buildSetupRunScriptPrompt(fileSyncEntries?: WorktreeFileSyncEntry[]): string {
  const nodeModulesEnabled = fileSyncEntries?.some(e => e.path === 'node_modules' && e.enabled) ?? true;
  const envEnabled = fileSyncEntries?.some(e => e.path.startsWith('.env') && e.enabled) ?? true;

  const depsStep = nodeModulesEnabled
    ? '3. Dependencies are pre-installed by Pane (node_modules is copied and install runs automatically in new worktrees). Just verify freshness — if the lock file has changed since node_modules was last updated, re-run the appropriate install command'
    : '3. Auto-detects if deps need installing (package.json mtime > node_modules mtime)';

  const envNote = envEnabled
    ? '\n- Environment files (.env, .env.local, etc.) are automatically copied from the main repo by Pane — do not prompt the user to create them or warn about missing env files'
    : '';

  return `I use Pane to manage multiple AI coding sessions with git worktrees.
Each worktree needs its own dev server on a unique port.

Create scripts/pane-run-script.js (Node.js, cross-platform) that:
1. Auto-detects git worktrees vs main repo
2. Assigns ports from the PANE_PORT environment variable that Pane injects into every pane terminal: each pane gets its own block of 10 ports starting at PANE_PORT, so PANE_PORT, PANE_PORT+1, ... PANE_PORT+9 are safe to use. Falls back to hash(cwd) % 1000 + base_port (separate ranges for main vs worktrees) only if PANE_PORT is unset
${depsStep}
4. Auto-detects if build is stale (src mtime > dist mtime)
5. Clean Ctrl+C termination (taskkill on Windows, SIGTERM on Unix)
6. Auto-detects project type (package.json, requirements.txt, Cargo.toml, go.mod, etc.)
7. Prints the URL/port being used so user knows where to access the app

CRITICAL EDGE CASES — these cause the most bugs:
- Port availability checks MUST test BOTH 0.0.0.0 AND :: (IPv6) — dev servers often bind to :: (all interfaces), so a check on 127.0.0.1 alone passes but the server fails with EADDRINUSE
- Before auto-incrementing to a new port, try to RECLAIM the preferred port by finding the PID holding it (lsof/netstat), verifying it belongs to this project's dev server (match the command line against the project directory or dev server binary), and only then killing it — never kill unrelated processes
- Clean up stale framework lock files before starting (.next/dev/lock, .cache/lock, .vite/ temp files, etc.) — these are left by crashed/killed sessions and prevent restart
- Cross-platform process management (taskkill /F /T on Windows, kill process group on Unix)${envNote}

Analyze this project's actual framework and structure first, then create the complete pane-run-script.js tailored to it.

IMPORTANT: After creating the script, TEST THE RESTART PATH — run 'node scripts/pane-run-script.js', then kill it ungracefully (Ctrl+C or kill the terminal), then run it again. It must reclaim the same port without EADDRINUSE or lock file errors. A single happy-path run proves nothing. Then commit and merge to main so all future worktrees have it.`;
}

function getPanelIcon(type: ToolPanelType, panel?: ToolPanel) {
  // Check for brand-specific terminal panels by title
  if (type === 'terminal' && panel) {
    const title = panel.title.toLowerCase();
    for (const [keyword, IconComponent] of Object.entries(CLI_BRAND_ICONS)) {
      if (title.includes(keyword)) {
        return <IconComponent className="w-4 h-4" />;
      }
    }
  }
  switch (type) {
    case 'terminal':
      return <Terminal className="w-4 h-4" />;
    case 'diff':
      return <GitBranch className="w-4 h-4" />;
    case 'explorer':
      return <FolderTree className="w-4 h-4" />;
    case 'editor':
      return panel && editorPanelState(panel)?.diff ? <FileDiff className="w-4 h-4" /> : <FileText className="w-4 h-4" />;
    case 'logs':
      return <FileCode className="w-4 h-4" />;
    case 'dashboard':
      return <BarChart3 className="w-4 h-4" />;
    case 'browser':
      return <Globe className="w-4 h-4" />;
    default:
      return null;
  }
}

export const PanelTabBar: React.FC<PanelTabBarProps> = memo(({
  panels,
  activePanel,
  onPanelSelect,
  onPanelClose,
  onPanelCreate,
  onShowExplorer,
  projectEnvironment,
  context = 'worktree',  // Default to worktree for backward compatibility
  onToggleDetailPanel,
  detailPanelVisible,
  detailPanelToggleDisabled = false,
  detailPanelToggleDisabledReason = 'Unavailable in this view',
  // Optional split tab group integration
  primaryGroupPanels,
  primaryGroupActivePanelId,
  primaryGroupFocused,
  tabsInGroups = false,
  onDragStart,
  onDragEnd,
  onStripDrop,
  isTabDragging,
  draggedPanelId,
  getPanelTabPresentation,
}) => {
  const agentPresets = useMemo(
    () => visibleAgentPresets(projectEnvironment),
    [projectEnvironment],
  );
  const sessionContext = useSession();
  const session = sessionContext?.session;
  const [resolvedRunScript, setResolvedRunScript] = useState<{ command: string; source: string } | null>(null);
  const { config, fetchConfig, updateConfig } = useConfigStore();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const addToolButtonRef = useRef<HTMLButtonElement>(null);
  const dropdownMenuRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  // A group strip's "+" opens this same menu, anchored to that button instead.
  const externalAnchorRef = useRef<DOMRect | null>(null);
  const trailingSlot = useTitleBarSlotStore((state) => state.trailingSlot);
  // Rename state moved to PanelTabStrip
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [editingCustomIndex, setEditingCustomIndex] = useState<number | null>(null);
  const [focusedDropdownIndex, setFocusedDropdownIndex] = useState(-1);
  const dropdownItemsRef = useRef<(HTMLButtonElement | HTMLInputElement | null)[]>([]);

  // Activity status moved to PanelTabStrip

  const customCommands = config?.customCommands ?? [];
  const hotkeys = useHotkeyStore((s) => s.hotkeys);
  const hotkeyDisplay = useCallback((id: string) => {
    const keys = hotkeys.get(id)?.keys;
    return keys ? formatKeyDisplay(keys) : null;
  }, [hotkeys]);

  // Load config on mount if not already loaded
  useEffect(() => {
    if (!config) {
      fetchConfig();
    }
  }, [config, fetchConfig]);

  // Resolve run script for current session — re-resolves on session change or project settings update
  const [resolveKey, setResolveKey] = useState(0);
  useEffect(() => {
    const handler = () => setResolveKey(k => k + 1);
    window.addEventListener('project-settings-updated', handler);
    return () => window.removeEventListener('project-settings-updated', handler);
  }, []);
  useEffect(() => {
    const currentSessionId = session?.id;
    if (!currentSessionId) {
      setResolvedRunScript(null);
      return;
    }
    let cancelled = false;
    window.electronAPI?.projects.resolveRunScript(currentSessionId).then((result: { success: boolean; data?: { command: string; source: string } | null }) => {
      if (cancelled) return;
      if (result?.success) {
        setResolvedRunScript(result.data ?? null);
      }
    }).catch(() => {
      if (!cancelled) setResolvedRunScript(null);
    });
    return () => { cancelled = true; };
  }, [session?.id, resolveKey]);

  const deleteCustomCommand = useCallback(async (index: number) => {
    const existing = config?.customCommands ?? [];
    await updateConfig({
      customCommands: existing.filter((_, i) => i !== index)
    }).catch(() => {});
  }, [config, updateConfig]);
  
  // Add Tool dropdown positioning
  useEffect(() => {
    if (!showDropdown || !dropdownRef.current) return;
    const updatePosition = () => {
      if (!dropdownRef.current) return;
      const rect = externalAnchorRef.current ?? dropdownRef.current.getBoundingClientRect();
      const width = Math.min(
        ADD_TOOL_MENU_WIDTH,
        window.innerWidth - (ADD_TOOL_MENU_VIEWPORT_MARGIN * 2),
      );
      const left = Math.max(
        ADD_TOOL_MENU_VIEWPORT_MARGIN,
        Math.min(
          rect.left,
          window.innerWidth - width - ADD_TOOL_MENU_VIEWPORT_MARGIN,
        ),
      );
      setDropdownStyle({
        position: 'fixed',
        top: rect.bottom + 4,
        left,
        zIndex: 10000,
        width,
        maxWidth: `calc(100vw - ${ADD_TOOL_MENU_VIEWPORT_MARGIN * 2}px)`,
        maxHeight: Math.max(0, window.innerHeight - rect.bottom - 4 - ADD_TOOL_MENU_VIEWPORT_MARGIN),
        overflowY: 'auto',
        // Pinned under the button's left edge, so that corner is where the menu
        // should look like it grew from.
        transformOrigin: 'top left',
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [showDropdown]);

  // Memoize event handlers to prevent unnecessary re-renders
  const handlePanelClick = useCallback((panel: ToolPanel) => {
    onPanelSelect(panel);
  }, [onPanelSelect]);

  // PanelTabStrip owns stopPropagation and the logs-running close guard
  const handlePanelClose = useCallback((panel: ToolPanel) => {
    onPanelClose(panel);
  }, [onPanelClose]);
  
  const handleAddPanel = useCallback((type: ToolPanelType, options?: PanelCreateOptions) => {
    onPanelCreate(type, options);
    setShowDropdown(false);
    setShowCustomInput(false);
    setEditingCustomIndex(null);
  }, [onPanelCreate]);
  
  // Rename handlers moved to PanelTabStrip
  
  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        event.target &&
        event.target instanceof Node &&
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target) &&
        dropdownMenuRef.current &&
        !dropdownMenuRef.current.contains(event.target)
      ) {
        setShowDropdown(false);
        setShowCustomInput(false);
        setEditingCustomIndex(null);
      }
    };

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDropdown]);

  // Group strips ask for the menu with their own "+" as the anchor.
  useEffect(() => {
    const handleOpenRequest = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      externalAnchorRef.current = event.detail?.rect ?? null;
      setShowDropdown(true);
    };
    window.addEventListener('pane:open-add-tool', handleOpenRequest);
    return () => window.removeEventListener('pane:open-add-tool', handleOpenRequest);
  }, []);
  useEffect(() => {
    if (!showDropdown) externalAnchorRef.current = null;
  }, [showDropdown]);

  // Reset focus index when dropdown closes, focus first item when opens
  useEffect(() => {
    if (showDropdown) {
      setFocusedDropdownIndex(0);
    } else {
      setFocusedDropdownIndex(-1);
      setShowCustomInput(false);
      setEditingCustomIndex(null);
      dropdownItemsRef.current = [];
    }
  }, [showDropdown]);

  useEffect(() => {
    if (showDropdown && focusedDropdownIndex >= 0) {
      dropdownItemsRef.current[focusedDropdownIndex]?.focus();
    }
  }, [focusedDropdownIndex, showDropdown]);

  // Handle keyboard navigation in dropdown
  const handleDropdownKeyDown = useCallback((e: React.KeyboardEvent) => {
    const items = dropdownItemsRef.current.filter(Boolean);
    const itemCount = items.length;

    if (itemCount === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusedDropdownIndex(prev => {
          return prev < itemCount - 1 ? prev + 1 : 0;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusedDropdownIndex(prev => {
          return prev > 0 ? prev - 1 : itemCount - 1;
        });
        break;
      case 'Escape':
        e.preventDefault();
        setShowDropdown(false);
        requestAnimationFrame(() => addToolButtonRef.current?.focus());
        break;
      case 'Tab':
        // Allow tab to close dropdown and move to next element
        setShowDropdown(false);
        break;
    }
  }, []);
  
  // Ctrl+T: open Add Tool dropdown
  useHotkey({
    id: 'open-add-tool',
    label: 'Open Add Tool menu',
    keys: 'mod+t',
    category: 'tabs',
    action: () => setShowDropdown(true),
  });

  /**
   * Run Dev Server — Play button handler (also triggered by Ctrl+Shift+D hotkey).
   *
   * Behavior depends on whether a run script was resolved:
   *
   * 1. If resolved: runs the resolved command in a terminal panel.
   *    Resolution is done by `projects:resolve-run-script` IPC (see project.ts)
   *    which checks, in order:
   *      - DB run_script (Project Settings)
   *      - pane.json scripts.run
   *      - conductor.json scripts.run
   *      - .gitpod.yml first task command
   *      - devcontainer.json postStartCommand
   *      - scripts/pane-run-script.js in the worktree
   *
   * 2. If nothing resolved: launches Claude to auto-generate a run script
   *    tailored to the project's framework (the "Setup Run Script" flow).
   *
   * The tooltip shows which command will run and its source (e.g. "from pane.json").
   */
  const handleRunDevServer = useCallback(async () => {
    if (!session) return;
    if (resolvedRunScript) {
      handleAddPanel('terminal', {
        initialCommand: resolvedRunScript.command,
        title: 'Dev Server'
      });
    } else {
      // No run script resolved — let Claude set one up
      handleAddPanel('terminal', {
        initialCommand: `claude --dangerously-skip-permissions "${buildSetupRunScriptPrompt(config?.worktreeFileSync).replace(/\n/g, ' ')}"`,
        title: 'Setup Run Script'
      });
    }
  }, [session, handleAddPanel, resolvedRunScript, config?.worktreeFileSync]);

  // Ctrl+Shift+D: Run Dev Server
  useHotkey({
    id: 'run-dev-server',
    label: 'Run Dev Server',
    keys: 'mod+shift+d',
    category: 'tools',
    action: handleRunDevServer,
    enabled: () => !!session,
  });

  // Get available panel types (excluding permanent panels, logs, and enforcing singleton)
  // SAFETY: The value comes from the adjacent finite domain definition.
  const availablePanelTypes = (Object.keys(PANEL_CAPABILITIES) as ToolPanelType[])
    .filter(type => {
      const capabilities = PANEL_CAPABILITIES[type];

      // Filter based on context
      if (context === 'project' && !capabilities.canAppearInProjects) return false;
      if (context === 'worktree' && !capabilities.canAppearInWorktrees) return false;

      // Exclude permanent panels
      if (capabilities.permanent) return false;

      // Logs is created by running scripts; editor tabs by opening files
      if (type === 'logs' || type === 'editor') return false;

      // Enforce singleton panels
      if (capabilities.singleton) {
        // Check if a panel of this type already exists
        return !panels.some(p => p.type === type);
      }

      return true;
    });
  

  // Whether a tab drag is hovering the bar (drives the un-split affordance)
  const [dragOverBar, setDragOverBar] = useState(false);
  useEffect(() => {
    if (!isTabDragging) setDragOverBar(false);
  }, [isTabDragging]);

  // Sort panels: explorer first, diff second, then by position
  const sortedPanels = useMemo(() => {
    const typeOrder = (type: string) => {
      if (type === 'explorer') return 0;
      if (type === 'diff') return 1;
      if (type === 'browser') return 2;
      return 3;
    };
    return [...panels].sort((a, b) => {
      const orderDiff = typeOrder(a.type) - typeOrder(b.type);
      if (orderDiff !== 0) return orderDiff;
      return (a.metadata?.position ?? 0) - (b.metadata?.position ?? 0);
    });
  }, [panels]);

  const rightActions = (
        <div className="flex items-center gap-1 flex-shrink-0 ml-auto">
          {/* Run Dev Server button */}
          {session && (
            <Tooltip content={
                <span className="flex flex-col items-start gap-1">
                  <span className="text-text-secondary">
                    {resolvedRunScript
                      ? `Run: ${resolvedRunScript.command}`
                      : 'Set up run script (via Claude)'}
                  </span>
                  {resolvedRunScript && (
                    <span className="text-text-tertiary text-[10px]">from {resolvedRunScript.source}</span>
                  )}
                  {hotkeyDisplay('run-dev-server') && <Kbd size="xs" variant="muted" className="origin-left scale-[0.8]">{hotkeyDisplay('run-dev-server')}</Kbd>}
                </span>
              } side="bottom">
              <button
                type="button"
                aria-label={resolvedRunScript ? `Run ${resolvedRunScript.command}` : 'Set up run script'}
                className="inline-flex items-center justify-center h-[var(--panel-tab-height)] px-2.5 rounded text-text-tertiary hover:text-status-success hover:bg-surface-hover transition-colors flex-shrink-0"
                onClick={handleRunDevServer}
              >
                <Play aria-hidden="true" className="w-4 h-4" />
              </button>
            </Tooltip>
          )}

          {/* Detail panel toggle */}
          {onToggleDetailPanel && (
            <Tooltip
              content={detailPanelToggleDisabled
                ? detailPanelToggleDisabledReason
                : (
                  <span className="flex items-center gap-2">
                    <span>{detailPanelVisible ? 'Hide details' : 'Show details'}</span>
                    {hotkeyDisplay('toggle-detail-panel') && (
                      <Kbd size="xs" variant="muted">{hotkeyDisplay('toggle-detail-panel')}</Kbd>
                    )}
                  </span>
                )}
              side="bottom"
            >
              <button
                type="button"
                onClick={detailPanelToggleDisabled ? undefined : onToggleDetailPanel}
                disabled={detailPanelToggleDisabled}
                aria-disabled={detailPanelToggleDisabled}
                aria-label={detailPanelToggleDisabled
                  ? detailPanelToggleDisabledReason
                  : detailPanelVisible ? 'Hide details' : 'Show details'}
                className={cn(
                  "inline-flex items-center justify-center h-[var(--panel-tab-height)] w-[var(--panel-tab-height)] rounded-md transition-colors flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle",
                  detailPanelToggleDisabled
                    ? "text-text-muted cursor-not-allowed opacity-50"
                    : detailPanelVisible
                    ? "text-text-primary bg-surface-hover hover:text-interactive"
                    : "text-text-tertiary hover:text-text-primary hover:bg-surface-hover"
                )}
              >
                <PanelRight aria-hidden="true" className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
        </div>
  );

  // Once the pane is split every tab lives in its group strip, so the top row
  // has nothing to show and collapses — unless a drag is in flight (it is the
  // drop target that merges the groups) or the title bar cannot host the
  // controls (native-framed Linux).
  const barCollapsed = tabsInGroups && !isTabDragging && !!trailingSlot;

  return (
    <>
    <div className={cn("panel-tab-bar bg-bg-chrome flex-shrink-0", barCollapsed && "hidden")}>
      {/* Flex container */}
      <div
        className="relative flex items-center min-h-[var(--panel-tab-height)] pr-2"
        onDragOver={tabsInGroups && isTabDragging ? () => setDragOverBar(true) : undefined}
        onDragLeave={tabsInGroups && isTabDragging ? () => setDragOverBar(false) : undefined}
      >
        {/* Un-split affordance: dropping a tab on the top bar while split
            merges every group back into the primary group. Advertise that
            while a drag hovers the bar (pointer-events-none so drops pass
            through to the strip). */}
        {tabsInGroups && isTabDragging && dragOverBar && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] bg-surface-primary border border-[color-mix(in_srgb,var(--color-interactive-primary)_40%,transparent)] text-text-secondary shadow-dropdown">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
                <line x1="8" y1="2.5" x2="8" y2="13.5" strokeDasharray="2 2" opacity="0.5" />
                <path d="M5.5 8h5M9 6.5 10.5 8 9 9.5" />
              </svg>
              Drop to merge all tabs back here
            </span>
          </div>
        )}
        {/* Scrollable tab area — delegated to PanelTabStrip. When the pane is
            split, SessionView passes only the primary group's permanent tabs
            here (working tabs live in the group strips); shortcut hints are
            disabled then because the strip shows a subset and the 1-9 indexes
            would lie. */}
        <PanelTabStrip
          idNamespace="top"
          panels={primaryGroupPanels ?? sortedPanels}
          activePanelId={primaryGroupActivePanelId !== undefined ? primaryGroupActivePanelId : (activePanel?.id ?? null)}
          onPanelSelect={handlePanelClick}
          onPanelClose={handlePanelClose}
          isPrimary
          isFocused={primaryGroupFocused ?? true}
          showShortcutHints={!tabsInGroups}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onStripDrop={onStripDrop}
          isTabDragging={isTabDragging}
          draggedPanelId={draggedPanelId}
          getPanelTabPresentation={getPanelTabPresentation}
        />

        {/* Add Panel dropdown button - outside overflow container so dropdown isn't clipped */}
        <div className="relative h-[var(--panel-tab-height)] flex items-center flex-shrink-0" ref={dropdownRef}>
          <Tooltip content={hotkeyDisplay('open-add-tool') ? <Kbd>{hotkeyDisplay('open-add-tool')}</Kbd> : undefined} side="bottom">
            <button
              ref={addToolButtonRef}
              type="button"
              className={cn(
                "inline-flex items-center justify-center h-7 w-7 ml-0.5 text-text-tertiary hover:text-text-primary hover:bg-surface-hover rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle",
                tabsInGroups && "hidden",
              )}
              onClick={() => setShowDropdown(!showDropdown)}
              aria-label="Add tool"
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && !showDropdown) {
                  e.preventDefault();
                  setShowDropdown(true);
                }
              }}
              aria-haspopup="menu"
              aria-expanded={showDropdown}
            >
              <Plus className="w-4 h-4" />
            </button>
          </Tooltip>

          {showDropdown && (() => {
            // Track ref index for keyboard navigation
            let refIndex = 0;
            const menuItemClass = "flex items-center gap-2 w-full h-7 px-2.5 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus:bg-surface-hover focus:text-text-primary focus:outline-none text-left";
            const separator = <hr className="my-1 border-t border-border-primary" />;
            const otherPanelTypes = availablePanelTypes.filter(t => t !== 'terminal' && t !== 'explorer' && t !== 'browser');
            const groupLabel = (label: string) => (
              <div role="presentation" className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-muted">{label}</div>
            );
            const shortcut = (id: string) => (hotkeyDisplay(id) ? <Kbd variant="inline" className="ml-auto pl-3">{hotkeyDisplay(id)}</Kbd> : null);

            return createPortal(
            <div
              ref={dropdownMenuRef}
              className="min-w-[228px] py-1 bg-surface-primary border border-border-primary rounded-md shadow-dropdown z-50"
              style={dropdownStyle}
              role="menu"
              onKeyDown={handleDropdownKeyDown}
            >
              {/* Terminal - plain terminal */}
              {availablePanelTypes.includes('terminal') && (
                <button
                  type="button"
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('terminal')}
                >
                  <Terminal className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">Terminal</span>
                  {shortcut('add-tool-terminal')}
                </button>
              )}
              {/* Explorer */}
              {availablePanelTypes.includes('explorer') && (
                <button
                  type="button"
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => {
                    onShowExplorer();
                    setShowDropdown(false);
                  }}
                >
                  <FolderTree className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">Explorer</span>
                  {shortcut('add-tool-explorer')}
                </button>
              )}
              {availablePanelTypes.includes('browser') && (
                <button
                  type="button"
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('browser')}
                >
                  <Globe className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="truncate">Browser</span>
                </button>
              )}
              {availablePanelTypes.includes('terminal') && agentPresets.length > 0 && (
                <>
                  {separator}
                  {groupLabel('Presets')}
                </>
              )}
              {/* Built-in agents */}
              {availablePanelTypes.includes('terminal') && agentPresets.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel('terminal', {
                    initialCommand: preset.command,
                    title: preset.title
                  })}
                >
                  {getCliBrandIcon(preset.iconKey, 'w-3.5 h-3.5 flex-shrink-0')}
                  <span className="truncate">{preset.title}</span>
                  {shortcut(preset.hotkeyId)}
                </button>
              ))}
              {availablePanelTypes.includes('terminal') && separator}
              {/* Saved custom commands */}
              {availablePanelTypes.includes('terminal') && customCommands.map((cmd, index) => {
                const currentRefIndex = refIndex++;
                const shortcutDisplay = hotkeyDisplay(`add-tool-custom-${index}`);
                const displayName = truncateCustomCommandLabel(cmd.name);
                return (
                <div key={`custom-${index}`} role="none" className="flex min-w-0 items-center">
                  <Tooltip
                    content={(
                      <span className="block max-w-[min(32rem,calc(100vw-1rem))] whitespace-normal break-words">
                        <span className="block font-medium">{cmd.name}</span>
                        <span className="block">{cmd.command}</span>
                        <span className="mt-1 block text-xs text-text-tertiary">F2 to rename · Delete or Backspace to remove</span>
                      </span>
                    )}
                    side="bottom"
                  >
                    <button
                      ref={(el) => { dropdownItemsRef.current[currentRefIndex] = el; }}
                      type="button"
                      role="menuitem"
                      className={cn(menuItemClass, 'min-w-0 flex-1')}
                      onClick={() => handleAddPanel('terminal', {
                        initialCommand: cmd.command,
                        customResume: cmd.resume,
                        title: cmd.name
                      })}
                      onKeyDown={(e) => {
                        if (e.key === 'F2') {
                          e.preventDefault();
                          e.stopPropagation();
                          setEditingCustomIndex(index);
                          setShowCustomInput(true);
                        }
                        if (!showCustomInput && (e.key === 'Delete' || e.key === 'Backspace')) {
                          e.preventDefault();
                          e.stopPropagation();
                          deleteCustomCommand(index);
                        }
                      }}
                    >
                      {getCliBrandIcon(cmd.command, 'w-3.5 h-3.5 flex-shrink-0') || <TerminalSquare className="w-3.5 h-3.5 flex-shrink-0" />}
                      <span className="truncate">{displayName}</span>
                      {shortcutDisplay && <Kbd variant="inline" className="ml-auto pl-3">{shortcutDisplay}</Kbd>}
                    </button>
                  </Tooltip>
                  <button
                    type="button"
                    className="p-1 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary flex-shrink-0"
                    onClick={() => {
                      setEditingCustomIndex(index);
                      setShowCustomInput(true);
                    }}
                    aria-label={`Rename ${cmd.name} shortcut`}
                    title="Rename profile"
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    className="p-1 mr-1.5 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary flex-shrink-0"
                    disabled={showCustomInput}
                    onClick={() => deleteCustomCommand(index)}
                    aria-label={`Remove ${cmd.name} shortcut`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );})}
              {/* Add Custom Command input */}
              {availablePanelTypes.includes('terminal') && (
                showCustomInput ? (
                  <CustomCommandForm
                    key={editingCustomIndex ?? 'new'}
                    existing={editingCustomIndex === null ? undefined : customCommands[editingCustomIndex]}
                    onCancel={() => {
                      setShowCustomInput(false);
                      setEditingCustomIndex(null);
                    }}
                    onSave={async (name, command, resume) => {
                      const existing = config?.customCommands ?? [];
                      await updateConfig({
                        customCommands: editingCustomIndex === null
                          ? [...existing, { name, command, resume }]
                          : existing.map((entry, index) => index === editingCustomIndex ? { ...entry, name, resume } : entry),
                      });
                      if (editingCustomIndex === null) {
                        handleAddPanel('terminal', { initialCommand: command, title: name, customResume: resume });
                      } else {
                        setShowCustomInput(false);
                        setEditingCustomIndex(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    ref={(el) => { dropdownItemsRef.current[refIndex++] = el; }}
                    role="menuitem"
                    className={menuItemClass}
                    onClick={() => { setEditingCustomIndex(null); setShowCustomInput(true); }}
                  >
                    <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate">Add custom command…</span>
                  </button>
                )
              )}
              {/* Other panel types (terminal, explorer and browser are listed above) */}
              {otherPanelTypes.length > 0 && separator}
              {otherPanelTypes.map((type) => {
                const currentRefIndex = refIndex++;
                return (
                <button
                  key={type}
                  type="button"
                  ref={(el) => { dropdownItemsRef.current[currentRefIndex] = el; }}
                  role="menuitem"
                  className={menuItemClass}
                  onClick={() => handleAddPanel(type)}
                >
                  {getPanelIcon(type)}
                  <span className="capitalize">{type}</span>
                </button>
              );})}
            </div>,
            document.body
            );
          })()}
        </div>

        {/* Run / inspector controls live on the title plane when the
            window owns its title bar; otherwise they stay at the bar's end. */}
        {trailingSlot ? createPortal(rightActions, trailingSlot) : rightActions}
      </div>
    </div>

    </>
  );
});

PanelTabBar.displayName = 'PanelTabBar';
