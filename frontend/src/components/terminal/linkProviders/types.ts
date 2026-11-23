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
  /** A click on a web link; the event says whether Cmd or Ctrl was held. */
  onOpenUrl: (url: string, event: MouseEvent) => void;
  /** The pointer rests on a web link, or leaves it (the link popover). */
  onHoverUrl: (url: string, event: MouseEvent) => void;
  onLeaveUrl: () => void;
}
