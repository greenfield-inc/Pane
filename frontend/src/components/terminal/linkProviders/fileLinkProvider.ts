import type { ILink, ILinkProvider } from '@xterm/xterm';
import type { LinkProviderConfig } from './types';
import { isMac, isWindows, getModifierKeyName } from '../../../utils/platformUtils';

interface ParsedFilePath {
  path: string;
  line?: number;
  col?: number;
}

/**
 * Parse a WSL UNC path to extract distribution name.
 * Handles \\wsl.localhost\Distro\... and \\wsl$\Distro\...
 */
function parseWSLPath(windowsPath: string): { distro: string; linuxPath: string } | null {
  const normalized = windowsPath.replace(/\\/g, '/');
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i);
  if (!match) return null;
  return {
    distro: match[2],
    linuxPath: match[3] || '/',
  };
}

/**
 * Convert a Linux path to a Windows UNC path for WSL access.
 */
function linuxToUNCPath(linuxPath: string, distro: string): string {
  const windowsPath = linuxPath.replace(/\//g, '\\');
  return `\\\\wsl.localhost\\${distro}${windowsPath}`;
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

  // Check if working directory is a WSL UNC path
  const wslInfo = isWindows() ? parseWSLPath(config.workingDirectory) : null;

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

  /**
   * Resolve relative paths against working directory.
   * Handles WSL POSIX paths on Windows by converting to UNC paths.
   */
  function resolvePath(filePath: string): string {
    // Windows absolute paths - return as-is
    if (/^[A-Za-z]:/.test(filePath)) {
      return filePath;
    }

    // POSIX absolute paths
    if (filePath.startsWith('/')) {
      // If we're in a WSL context on Windows, convert to UNC path
      if (wslInfo) {
        return linuxToUNCPath(filePath, wslInfo.distro);
      }
      // On non-Windows or non-WSL, return as-is
      return filePath;
    }

    // Relative paths - resolve against working directory
    if (wslInfo) {
      // In WSL context, join with Linux path and convert to UNC
      const linuxResolved = `${wslInfo.linuxPath}/${filePath}`.replace(/\/+/g, '/');
      return linuxToUNCPath(linuxResolved, wslInfo.distro);
    }

    // Standard path resolution
    const resolved = `${config.workingDirectory}/${filePath}`.replace(/\/+/g, '/');
    // Handle Windows path separators - only convert on Windows
    return isWindows() ? resolved.replace(/\//g, '\\') : resolved;
  }

  return {
    // xterm passes a 1-based buffer line; buffer.getLine is 0-based and link
    // ranges are 1-based, so the range y is the line number as given.
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
          const resolvedPath = resolvePath(path);
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
              config.onShowTooltip(event, resolvedPath, `${modifierKey}+Click to open`);
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
