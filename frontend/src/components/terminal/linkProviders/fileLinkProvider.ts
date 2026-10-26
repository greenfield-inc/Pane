import { resolveTerminalPath } from '../resolveTerminalPath';
import type { ILink, ILinkProvider } from '@xterm/xterm';
import type { LinkProviderConfig } from './types';
import { isMac, getModifierKeyName } from '../../../utils/platformUtils';

interface ParsedFilePath {
  path: string;
  line?: number;
  col?: number;
}

/**
 * Creates a file link provider that detects file paths in terminal output.
 * Supports Unix paths, Windows paths, and paths with line:column numbers.
 */
export function createFileLinkProvider(config: LinkProviderConfig): ILinkProvider {
  // Regex patterns for different file path formats
  const UNIX_PATH = /(?:^|[\s"'`])([.~]?\/[\w\-./]+(?::\d+(?::\d+)?)?)/g;
  const WIN_QUOTED = /"([A-Za-z]:\\[^"]+)"/g; // Require quotes for paths with spaces
  const WIN_SIMPLE = /([A-Za-z]:\\[\w\-.\\/]+(?::\d+(?::\d+)?)?)/g;
  const RELATIVE_WITH_LINE = /(?:^|[\s"'`])([\w\-./]+\.[a-z]+:\d+(?::\d+)?)/g;

  /**
   * Parse line and column numbers from file path
   * Example: "file.ts:42:10" -> { path: "file.ts", line: 42, col: 10 }
   */
  function parseFilePath(match: string): ParsedFilePath {
    const lineMatch = match.match(/:(\d+)(?::(\d+))?$/);
    if (lineMatch) {
      return {
        path: match.slice(0, match.indexOf(':' + lineMatch[1])),
        line: parseInt(lineMatch[1], 10),
        col: lineMatch[2] ? parseInt(lineMatch[2], 10) : undefined,
      };
    }
    return { path: match };
  }

  return {
    provideLinks(lineNumber: number, callback: (links: ILink[] | undefined) => void) {
      const line = config.terminal.buffer.active.getLine(lineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const text = line.translateToString();
      const links: ILink[] = [];

      // Apply all patterns and collect matches
      const patterns = [UNIX_PATH, WIN_QUOTED, WIN_SIMPLE, RELATIVE_WITH_LINE];
      for (const regex of patterns) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
          const rawPath = match[1] || match[0];
          const { path, line: fileLine } = parseFilePath(rawPath);
          const resolvedPath = resolveTerminalPath(path, config.workingDirectory, config.homeDirectory);
          const isMacPlatform = isMac();
          const modifierKey = getModifierKeyName();

          links.push({
            range: {
              start: { x: match.index + 1, y: lineNumber },
              end: { x: match.index + match[0].length + 1, y: lineNumber },
            },
            text: rawPath,
            activate: (event: MouseEvent) => {
              // Only activate on Ctrl/Cmd+Click
              if (isMacPlatform ? event.metaKey : event.ctrlKey) {
                config.onShowFilePopover(event, resolvedPath, fileLine);
              }
            },
            hover: (event: MouseEvent) => {
              config.onShowTooltip(event, resolvedPath.absolutePath ?? path, resolvedPath.relativePath !== null
                ? `${modifierKey}+Click to open`
                : resolvedPath.absolutePath ? 'Outside this worktree' : 'Home directory unavailable');
            },
            leave: () => {
              config.onHideTooltip();
            },
          });
        }
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
