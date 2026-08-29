import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, ExternalLink, FolderOpen, Globe } from 'lucide-react';
import { TerminalPopover, PopoverButton } from './TerminalPopover';
import { InterceptorToast } from './InterceptorToast';
import { isWindows } from '../../utils/platformUtils';
import { copyTerminalText } from '../../utils/terminalClipboard';

export interface SelectionPopoverProps {
  visible: boolean;
  x: number;
  y: number;
  text: string;
  workingDirectory?: string;
  sessionId?: string;
  isRemoteMode?: boolean;
  /** Whether this session can host a Pane Browser panel; the button is hidden otherwise. */
  browserAvailable: boolean;
  onOpenInBrowser: (url: string) => void | Promise<void>;
  onClose: () => void;
}

const URL_PATTERN = /https?:\/\/[^\s<>"{}|\\^`[\]]+/;

// File path patterns - detect Unix paths, Windows paths, and relative paths with extensions
const FILE_PATH_PATTERNS = [
  /^[.~]?\/[\w\-./]+/, // Unix absolute or relative paths starting with / ./ ~/
  /^[A-Za-z]:[\\/][\w\-.\\/]+/, // Windows absolute paths C:\ or C:/
  /^[\w\-./\\]+\.[a-z]{1,10}(:\d+)?$/i, // Relative paths with extension like foo.ts, foo.ts:42, or dir\foo.ts
];

function isFilePath(text: string): boolean {
  const trimmed = text.trim();
  return FILE_PATH_PATTERNS.some(pattern => pattern.test(trimmed));
}

function resolveFilePath(text: string, workingDirectory?: string): string {
  const trimmed = text.trim();
  // Remove line:col suffix if present
  const pathOnly = trimmed.replace(/:\d+(:\d+)?$/, '');

  // If it's an absolute path, return as-is
  if (pathOnly.startsWith('/') || /^[A-Za-z]:/.test(pathOnly)) {
    return pathOnly;
  }

  // Resolve relative to working directory
  if (workingDirectory) {
    const separator = isWindows() ? '\\' : '/';
    // Normalize path separators to the platform's separator
    const normalizedPath = pathOnly.replace(/[/\\]/g, separator);
    const normalizedDir = workingDirectory.replace(/[/\\]/g, separator);
    return `${normalizedDir}${separator}${normalizedPath}`;
  }

  return pathOnly;
}

export const SelectionPopover: React.FC<SelectionPopoverProps> = ({
  visible,
  x,
  y,
  text,
  workingDirectory,
  sessionId,
  isRemoteMode = false,
  browserAvailable,
  onOpenInBrowser,
  onClose,
}) => {
  // Stays mounted while hidden so the error toast can outlive the popover
  const [errorToast, setErrorToast] = useState<string | null>(null);

  // Skip computation when not visible
  const trimmedText = visible ? text.trim() : '';
  const urlMatch = visible ? trimmedText.match(URL_PATTERN) : null;
  const isUrl = urlMatch !== null;
  const isFile = visible && !isUrl && isFilePath(trimmedText);

  const handleCopy = async () => {
    try {
      await copyTerminalText(text);
      onClose();
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      setErrorToast('Failed to copy terminal text');
    }
  };

  const handleOpenUrl = () => {
    if (urlMatch) {
      // Extract just the URL, not surrounding text like "error: https://..."
      window.electronAPI.openExternal(urlMatch[0]);
      onClose();
    }
  };

  const handleOpenInBrowser = async () => {
    if (urlMatch && sessionId && browserAvailable) {
      try {
        await onOpenInBrowser(urlMatch[0]);
      } catch (error) {
        console.error('Failed to open URL in browser panel:', error);
      } finally {
        onClose();
      }
    }
  };

  const handleShowInExplorer = async () => {
    if (isFile) {
      if (isRemoteMode) {
        console.warn('Show in Explorer is only available in local mode.');
        onClose();
        return;
      }

      const resolvedPath = resolveFilePath(trimmedText, workingDirectory);
      try {
        const result: { success: boolean; error?: string } = await window.electronAPI.invoke(
          'app:showItemInFolder',
          resolvedPath,
          sessionId
        );
        if (!result?.success) {
          setErrorToast(result?.error || 'Failed to show in file manager');
        }
      } catch (error) {
        console.error('Failed to show in explorer:', error);
        setErrorToast('Failed to show in file manager');
      }
      onClose();
    }
  };

  return (
    <>
    <TerminalPopover visible={visible} x={x} y={y} onClose={onClose}>
      <PopoverButton onClick={handleCopy}>
        <span className="flex items-center gap-2">
          <Copy className="w-4 h-4" />
          Copy
        </span>
      </PopoverButton>
      {isUrl && sessionId && browserAvailable && (
        <PopoverButton onClick={handleOpenInBrowser}>
          <span className="flex items-center gap-2">
            <Globe className="w-4 h-4" />
            Open in Browser
          </span>
        </PopoverButton>
      )}
      {isUrl && (
        <PopoverButton onClick={handleOpenUrl}>
          <span className="flex items-center gap-2">
            <ExternalLink className="w-4 h-4" />
            Open URL
          </span>
        </PopoverButton>
      )}
      {isFile && (
        <PopoverButton
          onClick={handleShowInExplorer}
          disabled={isRemoteMode}
          title={isRemoteMode ? 'Only available in local mode' : undefined}
        >
          <span className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            Show in Explorer{isRemoteMode ? ' (local only)' : ''}
          </span>
        </PopoverButton>
      )}
    </TerminalPopover>
    {errorToast && createPortal(
      <div className="fixed inset-0 z-[10002] pointer-events-none">
        <InterceptorToast
          visible={!!errorToast}
          message={errorToast}
          onHide={() => setErrorToast(null)}
        />
      </div>,
      document.body
    )}
    </>
  );
};
