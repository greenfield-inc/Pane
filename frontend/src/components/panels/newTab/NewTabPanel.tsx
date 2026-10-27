import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Pencil, Terminal, X } from 'lucide-react';
import type { ProjectEnvironment, TerminalPanelState, ToolPanel, ToolPanelType } from '../../../../../shared/types/panels';
import type { PanelCreateOptions } from '../../../types/panelComponents';
import type { AgentLaunchPreset } from '../../../../../shared/constants/agentLaunchPresets';
import { useConfigStore } from '../../../stores/configStore';
import { usePanelStore } from '../../../stores/panelStore';
import { useHostShellSettings } from '../../../hooks/useHostShellSettings';
import { useAgentReadiness, type AgentReadiness } from '../../../hooks/useAgentReadiness';
import { visibleAgentPresets } from '../../../utils/agentPresets';
import { getCliBrandIcon } from '../../ui/brandIconRegistry';
import { Tooltip } from '../../ui/Tooltip';
import { cn } from '../../../utils/cn';
import { CustomCommandForm } from '../CustomCommandForm';
import { addablePanelTypes } from '../addablePanelTypes';
import { agentSetupTerminal } from './agentSetup';
import { useNewTabActions } from './newTabActions';

const EMPTY_PANELS: ToolPanel[] = [];

interface NewTabPickerProps {
  sessionId: string;
  projectId?: number;
  projectEnvironment?: ProjectEnvironment;
  isActive: boolean;
  /** Open the chosen tool. */
  choose: (type: ToolPanelType, options?: PanelCreateOptions) => Promise<void> | void;
  showExplorer: () => void;
}

/** What a row says on its right, by readiness. Blank while checking or when unknown; those rows still launch. */
function ReadinessLabel({ readiness }: { readiness: AgentReadiness }) {
  switch (readiness) {
    case 'ready':
      return <span className="text-status-success">Ready</span>;
    case 'signed-out':
      return <span><span className="text-status-warning">Sign in needed</span><span className="text-text-muted"> · </span><span className="text-interactive">Sign in</span></span>;
    case 'not-installed':
      return <span><span className="text-text-tertiary">Not installed</span><span className="text-text-muted"> · </span><span className="text-interactive">Install</span></span>;
    default:
      return null;
  }
}

/**
 * The "New tab" picker: what the "+" tab and an empty stage show. Agents show
 * whether they are installed and signed in where this Pane runs them. It
 * never hosts a terminal, so the terminal refresh rules do not apply here.
 */
export const NewTabPicker: React.FC<NewTabPickerProps> = ({ sessionId, projectId, projectEnvironment, isActive, choose, showExplorer }) => {
  const { config, updateConfig } = useConfigStore();
  const sessionPanels = usePanelStore(state => state.panels[sessionId] ?? EMPTY_PANELS);
  const presets = useMemo(() => visibleAgentPresets(projectEnvironment), [projectEnvironment]);
  const readiness = useAgentReadiness(projectId, useMemo(() => presets.map(preset => preset.id), [presets]));
  const isWindowsProject = projectEnvironment === 'windows';
  const { shells, preferredShell } = useHostShellSettings(isWindowsProject);
  const [customForm, setCustomForm] = useState<{ index: number | null } | null>(null);
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const titleId = useId();

  const customCommands = config?.customCommands ?? [];
  const otherTypes = addablePanelTypes(sessionPanels, 'worktree', config?.remoteDaemon?.client.mode === 'remote');

  const shellName = useMemo(() => {
    if (isWindowsProject) {
      return (shells.find(shell => shell.id === preferredShell) ?? shells[0])?.name;
    }
    // SAFETY: Terminal panels keep TerminalPanelState as their custom state.
    const shellType = sessionPanels
      .map(candidate => candidate.type === 'terminal' ? (candidate.state.customState as TerminalPanelState | undefined)?.shellType : undefined)
      .find(Boolean);
    return shellType?.replace(/\.exe$/iu, '');
  }, [isWindowsProject, shells, preferredShell, sessionPanels]);

  const chooseAgent = useCallback((preset: AgentLaunchPreset) => {
    const state = readiness[preset.id];
    const setup = state === 'signed-out'
      ? agentSetupTerminal(preset.id, 'sign-in', projectEnvironment)
      : state === 'not-installed' ? agentSetupTerminal(preset.id, 'install', projectEnvironment) : undefined;
    void choose('terminal', setup ?? { initialCommand: preset.command, title: preset.title });
  }, [choose, readiness, projectEnvironment]);

  // Focus the first ready agent once known, so Enter launches it; otherwise the first row.
  const firstReadyIndex = presets.findIndex(preset => readiness[preset.id] === 'ready');
  const focusIndex = firstReadyIndex >= 0 ? firstReadyIndex : 0;
  useEffect(() => {
    if (!isActive || customForm) return;
    if (rowsRef.current.some(row => row !== null && row === document.activeElement)) return;
    rowsRef.current[focusIndex]?.focus();
  }, [isActive, focusIndex, customForm]);

  const handleRowsKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const rows = rowsRef.current.filter((row): row is HTMLButtonElement => row !== null);
    const current = rows.findIndex(row => row === document.activeElement);
    const next = event.key === 'ArrowDown' ? (current + 1) % rows.length : (current - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  };

  const deleteCustomCommand = (index: number) => {
    void updateConfig({ customCommands: customCommands.filter((_, i) => i !== index) }).catch(() => {});
  };

  const rowClass = 'flex h-9 w-full items-center gap-2.5 rounded-md border border-border-primary bg-surface-secondary px-3 text-left text-[13px] text-text-primary hover:bg-surface-hover focus:outline-none focus-visible:border-interactive focus-visible:ring-1 focus-visible:ring-interactive';
  const linkClass = 'text-interactive hover:underline focus:outline-none focus-visible:underline';

  return (
    <div className="h-full w-full overflow-y-auto bg-bg-editor">
      <section aria-labelledby={`new-tab-title-${titleId}`} className="mx-auto mt-6 w-[calc(100%-2rem)] max-w-[380px] rounded-xl border border-border-primary bg-surface-primary p-4">
        <h2 id={`new-tab-title-${titleId}`} className="text-sm font-semibold text-text-primary">Start an agent here</h2>
        <p className="mt-0.5 text-xs text-text-tertiary">Runs in this Pane&apos;s worktree</p>
        <div className="mt-3 flex flex-col gap-2" onKeyDown={handleRowsKeyDown}>
          {presets.map((preset, index) => (
            <button
              key={preset.id}
              ref={el => { rowsRef.current[index] = el; }}
              type="button"
              className={rowClass}
              onClick={() => chooseAgent(preset)}
            >
              <span className="flex w-4 justify-center text-text-tertiary">{getCliBrandIcon(preset.iconKey, 'h-3.5 w-3.5')}</span>
              <span className={cn('truncate', readiness[preset.id] === 'ready' && 'font-medium')}>{preset.title}</span>
              <span className="ml-auto flex-shrink-0 text-[11px]"><ReadinessLabel readiness={readiness[preset.id]} /></span>
            </button>
          ))}
          <button
            ref={el => { rowsRef.current[presets.length] = el; }}
            type="button"
            className={rowClass}
            onClick={() => void choose('terminal')}
          >
            <span className="flex w-4 justify-center text-text-tertiary"><Terminal className="h-3.5 w-3.5" /></span>
            <span className="truncate">Plain terminal</span>
            {shellName && <span className="ml-auto flex-shrink-0 text-[11px] text-text-tertiary">{shellName}</span>}
          </button>
        </div>

        <p className="mt-3 break-words text-xs leading-5 text-text-tertiary">
          Other tools:{' '}
          {[
            otherTypes.includes('explorer') && <button key="explorer" type="button" className={linkClass} onClick={() => showExplorer()}>Explorer</button>,
            otherTypes.includes('browser') && <button key="browser" type="button" className={linkClass} onClick={() => void choose('browser')}>Browser</button>,
            otherTypes.includes('notes') && <button key="notes" type="button" className={linkClass} onClick={() => void choose('notes')}>Notes</button>,
            ...customCommands.map((cmd, index) => (
              <span key={`custom-${index}`} className="group">
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
                    type="button"
                    className={cn(linkClass, 'max-w-full break-words text-left')}
                    onClick={() => void choose('terminal', { initialCommand: cmd.command, customResume: cmd.resume, title: cmd.name })}
                    onKeyDown={event => {
                      if (event.key === 'F2') {
                        event.preventDefault();
                        setCustomForm({ index });
                      } else if (event.key === 'Delete' || event.key === 'Backspace') {
                        event.preventDefault();
                        deleteCustomCommand(index);
                      }
                    }}
                  >
                    {cmd.name}
                  </button>
                </Tooltip>
                <button type="button" aria-label={`Rename ${cmd.name} shortcut`} className="ml-0.5 inline-flex rounded p-0.5 align-middle text-text-muted opacity-0 hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100" onClick={() => setCustomForm({ index })}>
                  <Pencil className="h-3 w-3" />
                </button>
                <button type="button" aria-label={`Remove ${cmd.name} shortcut`} className="ml-0.5 inline-flex rounded p-0.5 align-middle text-text-muted opacity-0 hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100" onClick={() => deleteCustomCommand(index)}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            )),
            <button key="add-custom" type="button" className={linkClass} onClick={() => setCustomForm({ index: null })}>Add custom command…</button>,
          ].filter(Boolean).flatMap((item, index) => (index === 0 ? [item] : [<span key={`sep-${index}`} className="text-text-muted"> · </span>, item]))}
        </p>

        {customForm && (
          <div className="mt-3 rounded-md border border-border-primary">
            <CustomCommandForm
              key={customForm.index ?? 'new'}
              existing={customForm.index === null ? undefined : customCommands[customForm.index]}
              onCancel={() => setCustomForm(null)}
              onSave={async (name, command, resume) => {
                const index = customForm.index;
                await updateConfig({
                  customCommands: index === null
                    ? [...customCommands, { name, command, resume }]
                    : customCommands.map((entry, i) => (i === index ? { ...entry, name, resume } : entry)),
                });
                setCustomForm(null);
                if (index === null) await choose('terminal', { initialCommand: command, title: name, customResume: resume });
              }}
            />
          </div>
        )}
      </section>
    </div>
  );
};

/** The "+" tab: the picker, replaced in place by the tool the person picks. */
export const NewTabPanel: React.FC<{ panel: ToolPanel; isActive: boolean }> = ({ panel, isActive }) => {
  const actions = useNewTabActions();
  if (!actions) return null;
  return (
    <NewTabPicker
      sessionId={panel.sessionId}
      projectId={actions.projectId}
      projectEnvironment={actions.projectEnvironment}
      isActive={isActive}
      choose={(type, options) => actions.replace(panel, type, options)}
      showExplorer={() => actions.showExplorer(panel)}
    />
  );
};
