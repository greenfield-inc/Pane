import type { TerminalFilePath } from '../resolveTerminalPath';
import type { Terminal } from '@xterm/xterm';
import type { CustomLink } from '../../../../../shared/types/customLinks';

export interface LinkProviderConfig {
  terminal: Terminal;
  customLinks?: readonly CustomLink[];
  workingDirectory: string;
  homeDirectory?: string;
  githubRemoteUrl?: string; // e.g., "https://github.com/org/repo"
  onShowTooltip: (event: MouseEvent, text: string, hint: string) => void;
  onHideTooltip: () => void;
  onShowFilePopover: (event: MouseEvent, filePath: TerminalFilePath, line?: number) => void;
  onOpenUrl: (url: string) => void;
}
