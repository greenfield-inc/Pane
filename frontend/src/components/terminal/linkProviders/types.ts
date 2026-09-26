import type { Terminal } from '@xterm/xterm';

export interface LinkProviderConfig {
  terminal: Terminal;
  workingDirectory: string;
  githubRemoteUrl?: string; // e.g., "https://github.com/org/repo"
  onShowTooltip: (event: MouseEvent, text: string, hint: string) => void;
  onHideTooltip: () => void;
  onShowFilePopover: (event: MouseEvent, filePath: string, line?: number) => void;
  /** Routes one URL activation through the shared link router (gesture classification included). */
  onActivateUrl: (url: string, event: MouseEvent) => void;
  /** Hover hint advertising the available URL gestures for this session. */
  urlHoverHint: string;
}
