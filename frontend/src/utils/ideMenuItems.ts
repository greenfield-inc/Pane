import { Code2, TerminalSquare } from 'lucide-react';
import type { DropdownItem } from '../components/ui/Dropdown';
import { BUILT_IN_IDES, isBuiltInIdeCommand, type ConfiguredIde } from '../../../shared/utils/ideCommands';

const CONFIGURED_DESCRIPTION = {
  app: 'Default for all projects',
  project: 'Project default',
} satisfies Record<ConfiguredIde['source'], string>;

/** The configured IDE leads the menu unless it is one of the built-ins, which are always listed. */
export function ideMenuItems(
  configured: ConfiguredIde | undefined,
  openIde: (ideKey?: string) => void,
): DropdownItem[] {
  const custom: DropdownItem[] = configured && !isBuiltInIdeCommand(configured.command)
    ? [{
      id: 'configured',
      label: configured.command,
      description: CONFIGURED_DESCRIPTION[configured.source],
      icon: TerminalSquare,
      onClick: () => openIde(),
    }]
    : [];
  return [
    ...custom,
    ...BUILT_IN_IDES.map((ide) => ({
      id: ide.key,
      label: ide.label,
      description: ide.command,
      icon: Code2,
      onClick: () => openIde(ide.key),
    })),
  ];
}
