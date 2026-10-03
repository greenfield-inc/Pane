import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, ExternalLink, FolderOpen, Globe } from 'lucide-react';
import { TerminalPopover, PopoverButton } from './TerminalPopover';
import { InterceptorToast } from './InterceptorToast';
import { resolveTerminalPath } from './resolveTerminalPath';
import { copyTerminalText } from '../../utils/terminalClipboard';

export interface SelectionPopoverProps {
  visible: boolean;
  x: number;
  y: number;
  text: string;
  workingDirectory?: string;
  homeDirectory?: string;
  sessionId?: string;
  isRemoteMode?: boolean;
  onOpenInBrowser?: (url: string) => void | Promise<void>;
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

export const SelectionPopover: React.FC<SelectionPopoverProps> = ({
  visible,
  x,
  y,
  text,
  workingDirectory,
  homeDirectory,
  sessionId,
  isRemoteMode = false,
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

  const filePath = isFile ? resolveTerminalPath(trimmedText, workingDirectory ?? '', homeDirectory) : null;

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
    if (urlMatch && sessionId) {
      try {
        if (onOpenInBrowser) {
          await onOpenInBrowser(urlMatch[0]);
        } else {
          window.dispatchEvent(new CustomEvent('browser-panel:navigate', {
            detail: { url: urlMatch[0], sessionId }
          }));
        }
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

      const resolvedPath = filePath?.absolutePath;
      if (!resolvedPath) return;
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
      {isUrl && sessionId && (
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
          disabled={isRemoteMode || !filePath?.absolutePath}
          title={isRemoteMode ? 'Only available in local mode' : !filePath?.absolutePath ? 'Home directory unavailable' : undefined}
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
