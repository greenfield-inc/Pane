import { ChevronDown, FolderTree, Globe, Plus, TerminalSquare } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { RemotePwaCustomCommand } from '../../../../shared/types/remoteDaemon';
import type { ToolPanel } from '../../../../shared/types/panels';
import { AGENT_LAUNCH_PRESETS } from '../../../../shared/constants/agentLaunchPresets';
import { getCliBrandIcon } from '../../components/ui/brandIconRegistry';
import { getRemotePanelTabId, getRemotePanelTabPanelId } from './remotePanelTabIds';

// The remote host executes these commands. Until its platform capabilities are
// exposed here, the viewer's browser platform must not hide valid host tools.
const agentPresets = AGENT_LAUNCH_PRESETS;

export interface RemoteTerminalCreateOptions {
  title?: string;
  initialCommand?: string;
}

interface RemotePanelTabsProps {
  panels: ToolPanel[];
  selectedPanelId: string | null;
  creating: boolean;
  customCommands: RemotePwaCustomCommand[];
  onSelectPanel: (panelId: string) => void;
  onCreateTerminal: (options?: RemoteTerminalCreateOptions) => void;
  onCreateBrowser: () => void;
}

export function RemotePanelTabs({
  panels,
  selectedPanelId,
  creating,
  customCommands,
  onSelectPanel,
  onCreateTerminal,
  onCreateBrowser,
}: RemotePanelTabsProps) {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const addMenuId = useId();

  useEffect(() => {
    if (!showAddMenu) return;

    const closeOnPointerDown = (event: PointerEvent) => {
      // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
      if (!menuRef.current?.contains(event.target as Node)) {
        setShowAddMenu(false);
      }
    };

    window.addEventListener('pointerdown', closeOnPointerDown);
    return () => window.removeEventListener('pointerdown', closeOnPointerDown);
  }, [showAddMenu]);

  useEffect(() => {
    if (!showAddMenu) return;
    const frame = window.requestAnimationFrame(() => menuItemRefs.current[0]?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [showAddMenu]);

  const addTerminal = (options?: RemoteTerminalCreateOptions) => {
    onCreateTerminal(options);
    setShowAddMenu(false);
  };

  const selectTabAt = (index: number) => {
    const panel = panels[index];
    if (!panel) return;
    onSelectPanel(panel.id);
    tabRefs.current[index]?.focus();
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % panels.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + panels.length) % panels.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = panels.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectTabAt(nextIndex);
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = menuItemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    // SAFETY: The registered DOM/custom-event source establishes this target and detail shape.
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;

    if (event.key === 'ArrowDown') nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % items.length;
    if (event.key === 'ArrowUp') nextIndex = currentIndex < 0 ? items.length - 1 : (currentIndex - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (event.key === 'Escape') {
      event.preventDefault();
      setShowAddMenu(false);
      addTriggerRef.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      setShowAddMenu(false);
      return;
    }
    if (nextIndex !== null && items[nextIndex]) {
      event.preventDefault();
      items[nextIndex].focus();
    }
  };

  return (
    <div className="flex min-h-12 shrink-0 items-end gap-2 border-b border-border-primary bg-bg-secondary px-2 pt-2">
      <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto" role="tablist" aria-label="Remote tool panels">
        {panels.map((panel, index) => (
          <button
            key={panel.id}
            ref={(element) => { tabRefs.current[index] = element; }}
            type="button"
            role="tab"
            id={getRemotePanelTabId(panel.id)}
            aria-selected={selectedPanelId === panel.id}
            aria-controls={getRemotePanelTabPanelId(panel.id)}
            tabIndex={selectedPanelId === panel.id || (!selectedPanelId && index === 0) ? 0 : -1}
            onClick={() => onSelectPanel(panel.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
            // No transition: the selected tab is how you confirm the switch
            // landed, so it has to be right on the frame you tapped it.
            className={`relative flex h-10 max-w-[min(12rem,55vw)] shrink-0 items-center gap-2 rounded-t-lg border px-3 text-sm font-medium shadow-sm ${
              selectedPanelId === panel.id
                ? 'border-border-primary border-b-bg-primary bg-bg-primary text-text-primary shadow-[0_-1px_0_rgba(255,255,255,0.04)_inset]'
                : 'border-border-secondary bg-surface-primary text-text-secondary hover:border-border-primary hover:bg-surface-hover hover:text-text-primary'
            }`}
          >
            <PanelTabIcon type={panel.type} />
            <span className="truncate">{panel.title}</span>
          </button>
        ))}
      </div>

      <div ref={menuRef} className="relative shrink-0">
        <button
          ref={addTriggerRef}
          type="button"
          onClick={() => setShowAddMenu(value => !value)}
          disabled={creating}
          className="mb-1.5 flex h-8 shrink-0 items-center gap-1 rounded-md border border-border-secondary bg-surface-primary px-2 text-sm font-medium text-text-secondary shadow-sm hover:bg-surface-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 sm:px-3"
          aria-haspopup="menu"
          aria-expanded={showAddMenu}
          aria-controls={showAddMenu ? addMenuId : undefined}
          aria-label="Add tool"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Add Tool</span>
          <ChevronDown className="hidden h-3 w-3 sm:block" aria-hidden="true" />
        </button>

        {showAddMenu && (
          <div
            id={addMenuId}
            className="animate-dropdown-enter absolute right-0 top-full z-40 mt-2 w-[min(20rem,calc(100vw-1rem))] origin-top-right overflow-hidden rounded-lg border border-border-primary bg-surface-primary shadow-dropdown"
            role="menu"
            aria-label="Add tool"
            onKeyDown={handleMenuKeyDown}
          >
            <AddToolMenuItem
              buttonRef={(element) => { menuItemRefs.current[0] = element; }}
              icon={<TerminalSquare className="h-4 w-4" />}
              title="Terminal"
              description="Start a shell on the remote host"
              onClick={() => addTerminal()}
            />
            <AddToolMenuItem
              buttonRef={(element) => { menuItemRefs.current[1] = element; }}
              icon={<Globe className="h-4 w-4" />}
              title="Browser"
              description="Open the host's dev servers and pages"
              onClick={() => {
                onCreateBrowser();
                setShowAddMenu(false);
              }}
            />
            {agentPresets.map((preset, presetIndex) => (
              <AddToolMenuItem
                key={preset.id}
                buttonRef={(element) => { menuItemRefs.current[presetIndex + 2] = element; }}
                icon={getCliBrandIcon(preset.iconKey, 'h-4 w-4') ?? <TerminalSquare className="h-4 w-4" />}
                title={preset.title}
                description={`Run ${preset.command}`}
                onClick={() => addTerminal({
                  title: preset.title,
                  initialCommand: preset.command,
                })}
              />
            ))}
            {customCommands.map((command, index) => (
              <AddToolMenuItem
                key={`${command.name}-${index}`}
                buttonRef={(element) => { menuItemRefs.current[index + 2 + agentPresets.length] = element; }}
                icon={getCliBrandIcon(command.command, 'h-4 w-4') ?? <TerminalSquare className="h-4 w-4" />}
                title={command.name}
                description={command.command}
                onClick={() => addTerminal({
                  title: command.name,
                  initialCommand: command.command,
                })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PanelTabIcon({ type }: { type: ToolPanel['type'] }) {
  if (type === 'browser') return <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />;
  if (type === 'explorer') return <FolderTree className="h-4 w-4 shrink-0" aria-hidden="true" />;
  return <TerminalSquare className="h-4 w-4 shrink-0" aria-hidden="true" />;
}

function AddToolMenuItem({
  buttonRef,
  icon,
  title,
  description,
  onClick,
}: {
  buttonRef: (element: HTMLButtonElement | null) => void;
  icon: ReactNode;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      role="menuitem"
      tabIndex={-1}
      onClick={onClick}
      className="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
    >
      <span className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden="true">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium text-text-primary">{title}</span>
        <span className="block truncate text-xs text-text-tertiary">{description}</span>
      </span>
    </button>
  );
}
