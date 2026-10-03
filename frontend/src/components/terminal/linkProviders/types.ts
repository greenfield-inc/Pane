import type { TerminalFilePath } from '../resolveTerminalPath';
import type { Terminal } from '@xterm/xterm';

export interface LinkProviderConfig {
  terminal: Terminal;
  workingDirectory: string;
  homeDirectory?: string;
  githubRemoteUrl?: string; // e.g., "https://github.com/org/repo"
  onShowTooltip: (event: MouseEvent, text: string, hint: string) => void;
  onHideTooltip: () => void;
  onShowFilePopover: (event: MouseEvent, filePath: TerminalFilePath, line?: number) => void;
  onOpenUrl: (url: string) => void;
}
