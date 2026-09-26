import { Code2, TerminalSquare } from 'lucide-react';
import type { SessionContextValue } from '../contexts/sessionContextValue';
import type { DropdownItem } from './ui/Dropdown';

export const remoteIdeTooltip = 'Open in IDE is only available in local mode. Switch this client back to the local runtime to use your desktop IDE.';

export function detailBranchLabel(currentBranch?: string, baseBranch?: string): string {
  return currentBranch?.trim() || baseBranch?.replace(/^origin\//, '') || 'unknown';
}

export function detailIdeItems(configuredCommand: string | null | undefined, onOpen: SessionContextValue['onOpenIDEWithCommand']): DropdownItem[] {
  if (!onOpen) return [];
  const configured = configuredCommand?.trim();
  const isCustom = configured && !['code .', 'cursor .'].includes(configured);
  return [
    ...(isCustom ? [{ id: 'configured', label: configured, description: 'Project default', icon: TerminalSquare, onClick: () => onOpen() }] : []),
    { id: 'vscode', label: 'VS Code', description: 'code .', icon: Code2, onClick: () => onOpen('vscode') },
    { id: 'cursor', label: 'Cursor', description: 'cursor .', icon: Code2, onClick: () => onOpen('cursor') },
  ];
}
