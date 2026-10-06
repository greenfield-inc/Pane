import { useMemo } from 'react';
import { FileText, Globe, Plus, Terminal, TerminalSquare } from 'lucide-react';
import type { CustomCommandResume } from '../../../shared/types/customCommandResume';
import { useConfigStore } from '../stores/configStore';
import { visibleAgentPresets } from '../utils/agentPresets';
import { Dropdown, type DropdownItem } from './ui/Dropdown';
import { getCliBrandIcon } from './ui/brandIconRegistry';

/** A tool the Session "+" menu can open as a tab. */
export interface SessionToolSpec {
  type: 'terminal' | 'browser' | 'notes';
  title: string;
  initialCommand?: string;
  customResume?: CustomCommandResume | null;
}

/**
 * The Session stage's "+" menu: the same tools a pane's Add tool menu offers —
 * a terminal, a browser, the built-in agents, and saved custom commands — opened
 * as tabs in the Session's workspace.
 */
export function SessionAddToolMenu({ onAdd, disabled = false }: {
  onAdd: (tool: SessionToolSpec) => void;
  disabled?: boolean;
}) {
  const customCommands = useConfigStore(state => state.config?.customCommands);
  const items = useMemo<DropdownItem[]>(() => {
    const labelled = (icon: React.ReactNode, text: string) => (
      <span className="flex min-w-0 items-center gap-2">{icon}<span className="truncate">{text}</span></span>
    );
    return [
      { id: 'notes', label: labelled(<FileText className="h-3.5 w-3.5" />, 'Notes'), onClick: () => onAdd({ type: 'notes', title: 'Notes' }) },
      { id: 'terminal', label: labelled(<Terminal className="h-3.5 w-3.5 flex-shrink-0" />, 'Terminal'), onClick: () => onAdd({ type: 'terminal', title: 'Terminal' }) },
      { id: 'browser', label: labelled(<Globe className="h-3.5 w-3.5 flex-shrink-0" />, 'Browser'), onClick: () => onAdd({ type: 'browser', title: 'Browser' }) },
      ...visibleAgentPresets().map(preset => ({
        id: `preset-${preset.id}`,
        label: labelled(getCliBrandIcon(preset.iconKey, 'h-3.5 w-3.5 flex-shrink-0'), preset.title),
        onClick: () => onAdd({ type: 'terminal', title: preset.title, initialCommand: preset.command }),
      })),
      ...(customCommands ?? []).map((command, index) => ({
        id: `custom-${index}`,
        label: labelled(
          getCliBrandIcon(command.command, 'h-3.5 w-3.5 flex-shrink-0') ?? <TerminalSquare className="h-3.5 w-3.5 flex-shrink-0" />,
          command.name,
        ),
        onClick: () => onAdd({ type: 'terminal', title: command.name, initialCommand: command.command, customResume: command.resume }),
      })),
    ];
  }, [customCommands, onAdd]);

  return (
    <Dropdown
      trigger={(
        <button
          type="button"
          aria-label="Add tool"
          disabled={disabled}
          className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      items={items}
      position="bottom-left"
      width="md"
    />
  );
}
