import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ChevronRight, ChevronDown, File, Folder, RefreshCw, Plus, Trash2, FolderPlus, Search, X, Eye, Copy, FolderOpen, Pencil, Clipboard, ClipboardPaste, CopyPlus } from 'lucide-react';
import { useTree } from '@headless-tree/react';
import { asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, expandAllFeature } from '@headless-tree/core';
import type { ItemInstance } from '@headless-tree/core';
import { useCommittedRef } from '../../../hooks/useCommittedRef';
import { ExplorerPanelState } from '../../../../../shared/types/panels';
import { isMac, isWindows } from '../../../utils/platformUtils';
import { formatKeyDisplay } from '../../../utils/hotkeyUtils';
import { TerminalPopover, PopoverButton } from '../../terminal/TerminalPopover';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../../../stores/configStore';
import { LiveRegion } from '../../ui/LiveRegion';
import { boundary, decodeBoundary } from '../../../../../shared/validation/boundaryDecoder';
import { isHtmlFile } from './htmlFile';
import { previewHtmlFileInBrowser } from './previewHtmlFile';
import { editorPanelState, openFileInEditor } from '../../../services/openFileInEditor';
import { usePanelStore } from '../../../stores/panelStore';
interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: Date;
}

const ROOT_ID = '\0root';
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

function containsEventTarget(container: Node, target: EventTarget | null): boolean {
  return target instanceof Node && container.contains(target);
}

interface HeadlessFileTreeProps {
  sessionId: string;
  onFileSelect: (file: FileItem | null) => void;
  /** Double-click: open the file pinned (VS Code semantics). */
  onFileOpen?: (file: FileItem) => void;
  onFileCreateSelect?: (filePath: string) => void;
  selectedPath: string | null;
  initialExpandedDirs?: string[];
  initialSearchQuery?: string;
  initialShowSearch?: boolean;
  onTreeStateChange?: (state: { expandedDirs: string[]; searchQuery: string; showSearch: boolean }) => void;
  onHtmlPreview: (filePath: string) => void;
  /** Window-level shortcuts (⌘F, rename, delete, clipboard) only while the tree is the visible panel. */
  shortcutsActive?: boolean;
}

function HeadlessFileTree({
  sessionId,
  onFileSelect,
  onFileOpen,
  onFileCreateSelect,
  selectedPath,
  initialExpandedDirs,
  initialSearchQuery,
  initialShowSearch,
  onTreeStateChange,
  onHtmlPreview,
  shortcutsActive = true,
}: HeadlessFileTreeProps) {
  // Cache stores loaded directory contents. Key = dirPath, Value = FileItem[].
  const filesCacheRef = useRef(new Map<string, FileItem[]>());

  // Refs for values used in dataLoader (avoids stale closures)
  const sessionIdRef = useCommittedRef(sessionId);

  const [error, setError] = useState<string | null>(null);
  const setErrorRef = useCommittedRef(setError);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery || '');
  const [showSearch, setShowSearch] = useState(initialShowSearch || false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showNewItemDialog, setShowNewItemDialog] = useState<'file' | 'folder' | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [newItemParentPath, setNewItemParentPath] = useState('');
  const newItemInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<{ paths: string[]; mode: 'copy' | 'cut' } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');
  const skipRenameCommitRef = useRef(false);
  const itemElementRefs = useRef(new Map<string, HTMLDivElement>());

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FileItem | null;
  } | null>(null);

  // Platform-adaptive label
  const revealLabel = isMac() ? 'Reveal in Finder' : isWindows() ? 'Show in Explorer' : 'Show in File Manager';
  const isRemoteMode = useConfigStore((state) => state.config?.remoteDaemon?.client.mode === 'remote');
  const keyboardShortcutsEnabled = useConfigStore((state) => areKeyboardShortcutsEnabled(state.config));

  // Initialize expanded state from persisted state or default to root expanded.
  // Normalize legacy '' root to ROOT_ID so saved state from the old FileTree still works.
  const [expandedItems, setExpandedItems] = useState<string[]>(() => {
    if (!initialExpandedDirs?.length) return [ROOT_ID];
    const normalized = initialExpandedDirs.map(d => d === '' ? ROOT_ID : d);
    if (!normalized.includes(ROOT_ID)) normalized.unshift(ROOT_ID);
    return normalized;
  });

  // Data loader using getChildrenWithData for efficient loading
  const dataLoader = useMemo(() => ({
    getItem: (itemId: string): FileItem => {
      if (itemId === ROOT_ID) {
        return { name: '', path: '', isDirectory: true };
      }
      // Look up item in cache by checking its parent directory
      const parentPath = itemId.includes('/')
        ? itemId.substring(0, itemId.lastIndexOf('/'))
        : '';
      const siblings = filesCacheRef.current.get(parentPath);
      const found = siblings?.find(f => f.path === itemId);
      if (found) return found;

      // Fallback: return a placeholder that will be replaced when parent loads
      return { name: itemId.split('/').pop() || '', path: itemId, isDirectory: false };
    },

    getChildrenWithData: async (itemId: string): Promise<Array<{ id: string; data: FileItem }>> => {
      const dirPath = itemId === ROOT_ID ? '' : itemId;

      // If not root, check if this is actually a directory
      if (itemId !== ROOT_ID) {
        const parentPath = itemId.includes('/')
          ? itemId.substring(0, itemId.lastIndexOf('/'))
          : '';
        const parentItems = filesCacheRef.current.get(parentPath);
        const item = parentItems?.find(f => f.path === itemId);
        if (item && !item.isDirectory) return [];
      }

      try {
        const result = await window.electronAPI.invoke('file:list', {
          sessionId: sessionIdRef.current,
          path: dirPath,
        });
        if (result.success) {
          filesCacheRef.current.set(dirPath, result.files);
          return result.files.map((f: FileItem) => ({ id: f.path, data: f }));
        }
        setErrorRef.current(result.error ?? 'Failed to load directory');
      } catch (err) {
        console.error('Failed to load directory:', dirPath, err);
        setErrorRef.current(err instanceof Error ? err.message : 'Failed to load directory');
      }
      return [];
    },
  }), [sessionIdRef, setErrorRef]);

  const tree = useTree<FileItem>({
    rootItemId: ROOT_ID,
    getItemName: (item: ItemInstance<FileItem>) => item.getItemData()?.name ?? '',
    isItemFolder: (item: ItemInstance<FileItem>) => item.getItemData()?.isDirectory ?? false,
    dataLoader,
    createLoadingItemData: () => ({ name: 'Loading...', path: '', isDirectory: false }),
    features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, expandAllFeature],
    state: { expandedItems, selectedItems },
    setExpandedItems,
    setSelectedItems,
  });

  const getParentPath = useCallback((filePath: string) => (
    filePath.includes('/') ? filePath.substring(0, filePath.lastIndexOf('/')) : ''
  ), []);

  const getAncestorDirs = useCallback((filePath: string) => {
    const parts = filePath.split('/').filter(Boolean);
    const ancestors: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      ancestors.push(parts.slice(0, i).join('/'));
    }
    return ancestors;
  }, []);

  const revealItem = useCallback((filePath: string) => {
    let attempts = 0;
    const tryReveal = () => {
      const element = itemElementRefs.current.get(filePath);
      if (element) {
        element.scrollIntoView({ block: 'nearest' });
        return;
      }

      attempts += 1;
      if (attempts < 10) {
        window.setTimeout(tryReveal, 50);
      }
    };

    window.setTimeout(tryReveal, 0);
  }, []);

  const refreshDirectory = useCallback((dirPath: string) => {
    filesCacheRef.current.delete(dirPath);
    tree.getItemInstance(dirPath || ROOT_ID)?.invalidateChildrenIds();
  }, [tree]);

  const refreshAfterPathsChanged = useCallback((paths: string[]) => {
    const dirs = new Set<string>(['']);
    for (const filePath of paths) {
      dirs.add(getParentPath(filePath));
      getAncestorDirs(filePath).forEach(dir => dirs.add(dir));
      filesCacheRef.current.delete(filePath);
      const prefix = `${filePath}/`;
      for (const key of filesCacheRef.current.keys()) {
        if (key.startsWith(prefix)) filesCacheRef.current.delete(key);
      }
    }
    dirs.forEach(refreshDirectory);
  }, [getParentPath, getAncestorDirs, refreshDirectory]);

  useEffect(() => {
    if (!selectedPath) return;
    setSelectedItems([selectedPath]);
    setExpandedItems(prev => Array.from(new Set([ROOT_ID, ...prev, ...getAncestorDirs(selectedPath)])));
    revealItem(selectedPath);
  }, [selectedPath, getAncestorDirs, revealItem]);

  const getSelectedFilesForAction = useCallback((fallback: FileItem | null) => {
    if (fallback && !selectedItems.includes(fallback.path)) return [fallback];
    const selectedFiles = tree.getSelectedItems()
      .map(item => item.getItemData())
      .filter((item): item is FileItem => !!item && item.path !== '');
    return selectedFiles.length > 0 ? selectedFiles : fallback ? [fallback] : [];
  }, [selectedItems, tree]);

  const getContextTargetDir = useCallback((file: FileItem | null) => {
    if (!file) return '';
    return file.isDirectory ? file.path : getParentPath(file.path);
  }, [getParentPath]);

  // Session switch: clear cache and invalidate root
  const prevSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      filesCacheRef.current.clear();
      tree.getItemInstance(ROOT_ID)?.invalidateChildrenIds();
      prevSessionIdRef.current = sessionId;
    }
  }, [sessionId, tree]);

  // Highlight matching text in search results
  const highlightText = useCallback((text: string, query: string) => {
    if (!query) return text;
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = text.split(new RegExp(`(${escapedQuery})`, 'gi'));
    return (
      <>
        {parts.map((part, index) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <span key={index} className="bg-status-warning text-text-primary">
              {part}
            </span>
          ) : (
            part
          )
        )}
      </>
    );
  }, []);

  // Search: flat filtered results from cache
  const getFilteredFiles = useCallback((): FileItem[] => {
    if (!searchQuery) return [];
    const results: FileItem[] = [];
    const query = searchQuery.toLowerCase();
    filesCacheRef.current.forEach((items) => {
      for (const item of items) {
        if (item.name.toLowerCase().includes(query) || item.path.toLowerCase().includes(query)) {
          results.push(item);
        }
      }
    });
    return results;
  }, [searchQuery]);

  // Context menu handlers
  const handleCopyPath = useCallback(async () => {
    if (!contextMenu?.file) return;
    try {
      const result = await window.electronAPI.invoke('file:resolveAbsolutePath', {
        sessionId,
        path: contextMenu.file.path,
      });
      if (result.success && result.path) {
        await navigator.clipboard.writeText(result.path);
      }
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
    setContextMenu(null);
  }, [contextMenu, sessionId]);

  const handleCopyRelativePath = useCallback(async () => {
    if (!contextMenu?.file) return;
    try {
      await navigator.clipboard.writeText(contextMenu.file.path);
    } catch (err) {
      console.error('Failed to copy relative path:', err);
    }
    setContextMenu(null);
  }, [contextMenu]);

  const handleRevealInFileManager = useCallback(async () => {
    if (!contextMenu?.file) return;
    if (isRemoteMode) {
      setError('Show in file manager is only available in local mode. Switch this client back to the local runtime to reveal workspace files in your OS file manager.');
      setContextMenu(null);
      return;
    }
    try {
      await window.electronAPI.invoke('file:showInFolder', {
        sessionId,
        path: contextMenu.file.path,
      });
    } catch (err) {
      console.error('Failed to reveal in file manager:', err);
    }
    setContextMenu(null);
  }, [contextMenu, isRemoteMode, sessionId]);

  const handleDelete = useCallback(async (file: FileItem, options: { skipConfirm?: boolean } = {}) => {
    const files = getSelectedFilesForAction(file);
    const confirmMessage = files.length > 1
      ? `Move ${files.length} items to trash?`
      : files[0]?.isDirectory
        ? `Move folder "${files[0].name}" and all its contents to trash?`
        : `Move file "${files[0]?.name}" to trash?`;
    if (!options.skipConfirm && !confirm(confirmMessage)) return;

    try {
      for (const target of files) {
        const result = await window.electronAPI.invoke('file:delete', {
          sessionId,
          filePath: target.path,
          useTrash: true,
          allowPermanentFallback: !options.skipConfirm,
        });

        if (!result.success) {
          setError(`Failed to delete: ${result.error}`);
          return;
        }
      }

      refreshAfterPathsChanged(files.map(f => f.path));
      setSelectedItems(prev => prev.filter(path => !files.some(f => f.path === path || path.startsWith(`${f.path}/`))));

      if (files.some(target => selectedPath === target.path || selectedPath?.startsWith(`${target.path}/`))) {
        onFileSelect(null);
      }
    } catch (err) {
      console.error('Failed to delete:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete item');
    }
  }, [getSelectedFilesForAction, sessionId, refreshAfterPathsChanged, selectedPath, onFileSelect]);

  const startRename = useCallback((file: FileItem) => {
    skipRenameCommitRef.current = false;
    setRenamingPath(file.path);
    setRenamingValue(file.name);
    setContextMenu(null);
  }, []);

  const commitRename = useCallback(async (file: FileItem, value: string) => {
    const newName = value.trim();
    setRenamingPath(null);
    if (!newName || newName === file.name) return;

    try {
      const result = await window.electronAPI.invoke('file:rename', {
        sessionId,
        filePath: file.path,
        newName: newName.trim(),
      });

      if (!result.success) {
        setError(`Failed to rename: ${result.error}`);
        return;
      }

      const newPath = decodeBoundary(result.path, boundary.string);
      refreshAfterPathsChanged([file.path, newPath]);
      setSelectedItems([newPath]);
      if (selectedPath === file.path) {
        onFileSelect({ ...file, name: newName.trim(), path: newPath });
      }
    } catch (err) {
      console.error('Failed to rename:', err);
      setError(err instanceof Error ? err.message : 'Failed to rename item');
    }
  }, [sessionId, refreshAfterPathsChanged, selectedPath, onFileSelect]);

  const handleDuplicate = useCallback(async (file: FileItem) => {
    try {
      const result = await window.electronAPI.invoke('file:duplicate', {
        sessionId,
        filePath: file.path,
      });

      if (!result.success) {
        setError(`Failed to duplicate: ${result.error}`);
        return;
      }

      refreshAfterPathsChanged([file.path, decodeBoundary(result.path, boundary.string)]);
    } catch (err) {
      console.error('Failed to duplicate:', err);
      setError(err instanceof Error ? err.message : 'Failed to duplicate item');
    }
  }, [sessionId, refreshAfterPathsChanged]);

  const handleSetClipboard = useCallback((file: FileItem, mode: 'copy' | 'cut') => {
    const files = getSelectedFilesForAction(file);
    setClipboard({ paths: files.map(f => f.path), mode });
    setContextMenu(null);
  }, [getSelectedFilesForAction]);

  const handlePaste = useCallback(async (targetFile: FileItem | null) => {
    if (!clipboard || clipboard.paths.length === 0) return;
    const targetDir = getContextTargetDir(targetFile);

    try {
      for (const sourcePath of clipboard.paths) {
        if (clipboard.mode === 'cut' && getParentPath(sourcePath) === targetDir) {
          continue;
        }
        const result = await window.electronAPI.invoke(clipboard.mode === 'cut' ? 'file:move' : 'file:copy', {
          sessionId,
          sourcePath,
          targetDir,
        });

        if (!result.success) {
          setError(`Failed to ${clipboard.mode === 'cut' ? 'move' : 'copy'}: ${result.error}`);
          return;
        }
      }

      refreshAfterPathsChanged([...clipboard.paths, targetDir]);
      if (clipboard.mode === 'cut') setClipboard(null);
    } catch (err) {
      console.error('Failed to paste:', err);
      setError(err instanceof Error ? err.message : 'Failed to paste item');
    } finally {
      setContextMenu(null);
    }
  }, [clipboard, getContextTargetDir, getParentPath, sessionId, refreshAfterPathsChanged]);

  const openCreateDialog = useCallback((type: 'file' | 'folder', parent: FileItem | null) => {
    setShowNewItemDialog(type);
    setNewItemName('');
    setNewItemParentPath(getContextTargetDir(parent));
    setContextMenu(null);
  }, [getContextTargetDir]);

  // New file/folder creation with auto-open (the .md bug fix)
  const handleCreateNewItem = useCallback(async () => {
    if (!newItemName.trim()) return;

    try {
      const isFolder = showNewItemDialog === 'folder';
      const relativePath = newItemParentPath
        ? `${newItemParentPath}/${newItemName}`
        : newItemName;
      const filePath = isFolder ? `${relativePath}/.gitkeep` : relativePath;

      const result = await window.electronAPI.invoke('file:write', {
        sessionId,
        filePath,
        content: '',
      });

      if (result.success) {
        const createdItemPath = isFolder ? relativePath : filePath;
        refreshAfterPathsChanged([createdItemPath]);
        const dirsToExpand = [
          ROOT_ID,
          ...getAncestorDirs(createdItemPath),
          ...(isFolder ? [relativePath] : []),
        ];
        setExpandedItems(prev => Array.from(new Set([...prev, ...dirsToExpand])));
        setSelectedItems([createdItemPath]);
        revealItem(createdItemPath);

        // AUTO-OPEN: Select and open the new file in editor — this is the bug fix
        if (!isFolder) {
          const newFile: FileItem = {
            name: newItemName,
            path: relativePath,
            isDirectory: false,
          };
          onFileCreateSelect?.(newFile.path);
          onFileSelect(newFile);
        }

        setShowNewItemDialog(null);
        setNewItemName('');
        setNewItemParentPath('');
      } else {
        setError(`Failed to create ${isFolder ? 'folder' : 'file'}: ${result.error}`);
      }
    } catch (err) {
      console.error('Failed to create item:', err);
      setError(err instanceof Error ? err.message : 'Failed to create item');
    }
  }, [sessionId, newItemName, newItemParentPath, showNewItemDialog, onFileSelect, onFileCreateSelect, getAncestorDirs, revealItem, refreshAfterPathsChanged]);

  // Refresh all
  const handleRefreshAll = useCallback(() => {
    filesCacheRef.current.clear();
    tree.getItemInstance(ROOT_ID)?.invalidateChildrenIds();
    for (const item of tree.getItems()) {
      if (item.getItemData()?.isDirectory) {
        item.invalidateChildrenIds();
      }
    }
  }, [tree]);

  const uploadFile = useCallback((file: File, targetDir = ''): Promise<{ success: boolean; name: string; error?: string; filePath?: string }> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          // SAFETY: readAsDataURL completes with a string result before onload fires.
          const base64 = (reader.result as string).split(',')[1]; // Strip data URL prefix
          const result = await window.electronAPI.invoke('file:write-binary', {
            sessionId: sessionIdRef.current,
            fileName: file.name,
            contentBase64: base64,
            targetDir,
          });
          if (result.success) {
            resolve({ success: true, name: file.name, filePath: result.filePath });
          } else {
            resolve({ success: false, name: file.name, error: result.error });
          }
        } catch (err) {
          resolve({ success: false, name: file.name, error: err instanceof Error ? err.message : 'Unknown error' });
        }
      };
      reader.onerror = () => resolve({ success: false, name: file.name, error: 'Failed to read file' });
      reader.readAsDataURL(file);
    });
  }, [sessionIdRef]);

  const handleMoveToDirectory = useCallback(async (files: FileItem[], targetDir: string) => {
    const movingFiles = files.filter(file => file.path !== targetDir && !targetDir.startsWith(`${file.path}/`));
    if (movingFiles.length === 0) return;

    try {
      for (const file of movingFiles) {
        const result = await window.electronAPI.invoke('file:move', {
          sessionId,
          sourcePath: file.path,
          targetDir,
        });
        if (!result.success) {
          setError(`Failed to move "${file.name}": ${result.error}`);
          return;
        }
      }
      refreshAfterPathsChanged([...movingFiles.map(f => f.path), targetDir]);
    } catch (err) {
      console.error('Failed to move files:', err);
      setError(err instanceof Error ? err.message : 'Failed to move files');
    }
  }, [sessionId, refreshAfterPathsChanged]);

  const handleExternalFileDrop = useCallback(async (files: File[], targetDir = '') => {
    if (files.length === 0) return;

    const oversized = files.filter(f => f.size > MAX_FILE_SIZE);
    const validFiles = files.filter(f => f.size <= MAX_FILE_SIZE);

    if (validFiles.length === 0) {
      if (oversized.length > 0) {
        setError(`Files too large (max 15MB): ${oversized.map(f => f.name).join(', ')}`);
      }
      return;
    }

    setUploadStatus(`Uploading ${validFiles.length} file${validFiles.length > 1 ? 's' : ''}...`);

    try {
      const results: { success: boolean; name: string; error?: string; filePath?: string }[] = [];
      for (const file of validFiles) {
        results.push(await uploadFile(file, targetDir));
      }
      const failed = results.filter(r => !r.success);

      const errors: string[] = [];
      if (oversized.length > 0) {
        errors.push(`Too large (max 15MB): ${oversized.map(f => f.name).join(', ')}`);
      }
      if (failed.length > 0) {
        errors.push(`Failed: ${failed.map(r => `${r.name}${r.error ? ` (${r.error})` : ''}`).join(', ')}`);
      }
      if (errors.length > 0) setError(errors.join('. '));

      if (results.some(r => r.success)) {
        refreshDirectory(targetDir);
      }
    } finally {
      setUploadStatus(null);
    }
  }, [refreshDirectory, uploadFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
      if (!isDragOver) setIsDragOver(true);
    }
  }, [isDragOver]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!containsEventTarget(e.currentTarget, e.relatedTarget)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    setDragOverPath(null);
    setError(null);

    const files = Array.from(e.dataTransfer.files);
    await handleExternalFileDrop(files, '');
  }, [handleExternalFileDrop]);

  const handleInternalDrop = useCallback(async (e: React.DragEvent, targetDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverPath(null);
    setIsDragOver(false);

    const internalPayload = e.dataTransfer.getData('application/x-pane-file-paths');
    if (internalPayload) {
      try {
        const paths = decodeBoundary(JSON.parse(internalPayload), boundary.array(boundary.string));
        const files = paths
          .map(filePath => tree.getItemInstance(filePath)?.getItemData())
          .filter((item): item is FileItem => !!item);
        await handleMoveToDirectory(files, targetDir);
      } catch (err) {
        console.error('Failed to parse dropped file paths:', err);
        setError('Failed to move dropped items');
      }
      return;
    }

    await handleExternalFileDrop(Array.from(e.dataTransfer.files), targetDir);
  }, [handleExternalFileDrop, handleMoveToDirectory, tree]);

  // Focus input when dialog is shown
  useEffect(() => {
    if (showNewItemDialog && newItemInputRef.current) {
      newItemInputRef.current.focus();
    }
  }, [showNewItemDialog]);

  // Clear error after 5 seconds
  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  // Focus search input when shown
  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  // State persistence: notify parent about tree state changes
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (onTreeStateChange) {
      onTreeStateChange({
        expandedDirs: expandedItems,
        searchQuery,
        showSearch,
      });
    }
  }, [expandedItems, searchQuery, showSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard shortcuts
  useEffect(() => {
    if (!shortcutsActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const isEditingText = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || !!target?.isContentEditable;
      if (isEditingText && e.key !== 'Escape') return;

      if (keyboardShortcutsEnabled && (e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
      if (e.key === 'Escape') {
        if (contextMenu) {
          setContextMenu(null);
          return;
        }
        if (showNewItemDialog) {
          setShowNewItemDialog(null);
          setNewItemName('');
          return;
        }
        if (searchQuery) {
          setSearchQuery('');
          searchInputRef.current?.focus();
        }
      }
      if (!keyboardShortcutsEnabled) return;
      if (e.key === 'F2' && selectedItems.length === 1) {
        const item = tree.getItemInstance(selectedItems[0])?.getItemData();
        if (item) {
          e.preventDefault();
          startRename(item);
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedItems.length > 0) {
        const item = tree.getItemInstance(selectedItems[0])?.getItemData();
        if (item) {
          e.preventDefault();
          handleDelete(item, { skipConfirm: isMac() && e.metaKey });
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && selectedItems.length > 0) {
        e.preventDefault();
        setClipboard({ paths: selectedItems, mode: 'copy' });
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x' && selectedItems.length > 0) {
        e.preventDefault();
        setClipboard({ paths: selectedItems, mode: 'cut' });
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v' && clipboard) {
        e.preventDefault();
        handlePaste(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcutsActive, searchQuery, showNewItemDialog, contextMenu, keyboardShortcutsEnabled, selectedItems, tree, startRename, handleDelete, clipboard, handlePaste]);

  return (
    <div
      className={`h-full flex flex-col ${isDragOver ? 'ring-2 ring-interactive ring-inset bg-interactive/10' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <LiveRegion>{uploadStatus ?? ''}</LiveRegion>
      <div className="flex min-h-8 items-center justify-between px-3 py-1">
        <span className="text-[10px] font-semibold uppercase leading-4 tracking-wider text-text-tertiary">Files</span>
        <div className="flex gap-1">
          <button
            onClick={() => setShowSearch(prev => !prev)}
            className={`p-1 rounded text-text-tertiary hover:text-text-primary ${showSearch ? 'bg-surface-tertiary' : 'hover:bg-surface-hover'}`}
            title={`Search files (${formatKeyDisplay('mod+f')})`}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => { setShowNewItemDialog('file'); setNewItemName(''); setNewItemParentPath(''); }}
            className="p-1 hover:bg-surface-hover rounded text-text-tertiary hover:text-text-primary"
            title="New file"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => { setShowNewItemDialog('folder'); setNewItemName(''); setNewItemParentPath(''); }}
            className="p-1 hover:bg-surface-hover rounded text-text-tertiary hover:text-text-primary"
            title="New folder"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleRefreshAll}
            className="p-1 hover:bg-surface-hover rounded text-text-tertiary hover:text-text-primary"
            title="Refresh all"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {showSearch && (
        <div className="p-2 border-b border-border-primary">
          <div className="relative">
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files..."
              className="w-full pl-8 pr-8 py-1 bg-surface-primary border border-border-primary rounded text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-interactive focus:ring-1 focus:ring-interactive"
            />
            <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 w-4 h-4 text-text-tertiary" />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 transform -translate-y-1/2 p-0.5 hover:bg-surface-hover rounded"
              >
                <X className="w-3 h-3 text-text-tertiary" />
              </button>
            )}
          </div>
          {searchQuery && (
            <div className="mt-1 text-xs text-text-tertiary">
              Press ESC to clear • {formatKeyDisplay('mod+f')} to toggle search
            </div>
          )}
        </div>
      )}
      {showNewItemDialog && (
        <div className="p-2 border-b border-border-primary bg-surface-secondary">
          <form onSubmit={(e) => { e.preventDefault(); handleCreateNewItem(); }}>
            <input
              ref={newItemInputRef}
              type="text"
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              placeholder={`Enter ${showNewItemDialog} name${newItemParentPath ? ` in ${newItemParentPath}` : ''}...`}
              className="w-full px-2 py-1 mb-2 bg-surface-primary border border-border-primary rounded text-sm text-text-primary placeholder-text-tertiary focus:outline-none focus:border-interactive focus:ring-1 focus:ring-interactive"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!newItemName.trim()}
                className="flex-1 px-3 py-1 bg-interactive hover:bg-interactive-hover disabled:bg-surface-tertiary disabled:text-text-tertiary text-text-on-interactive rounded text-sm transition-colors"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => { setShowNewItemDialog(null); setNewItemName(''); setNewItemParentPath(''); }}
                className="flex-1 px-3 py-1 bg-surface-tertiary hover:bg-surface-hover text-text-secondary rounded text-sm transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
      {error && (
        <div role="alert" className="px-3 py-2 bg-status-error/20 text-status-error text-sm border-b border-status-error/30">
          {error}
        </div>
      )}
      {uploadStatus && (
        <div className="px-3 py-2 bg-interactive/20 text-interactive text-sm border-b border-interactive/30">
          {uploadStatus}
        </div>
      )}
      {/* Search mode: flat filtered results overlay */}
      {searchQuery && (
        <div className="flex-1 overflow-auto">
          {getFilteredFiles().map(file => (
            <div
              key={file.path}
              className={`group mx-2 flex w-[calc(100%-1rem)] items-center rounded-md hover:bg-surface-hover ${
                selectedPath === file.path ? 'bg-surface-selected' : ''
              }`}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenu({ x: e.clientX, y: e.clientY, file });
              }}
            >
              <button
                type="button"
                disabled={file.isDirectory}
                className="flex min-h-7 min-w-0 flex-1 items-center px-2 py-1 text-left disabled:cursor-default"
                onClick={() => onFileSelect(file)}
                onDoubleClick={() => onFileOpen?.(file)}
              >
                {file.isDirectory ? (
                  <Folder className="mr-2 h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
                ) : (
                  <File className="mr-2 h-3.5 w-3.5 flex-shrink-0 text-text-tertiary" />
                )}
                <span className="flex-1 truncate text-[12px] text-text-primary">
                  {highlightText(file.name, searchQuery)}
                </span>
                <span className="ml-2 max-w-[120px] truncate text-[10px] text-text-tertiary">
                  {file.path}
                </span>
              </button>
              {!file.isDirectory && isHtmlFile(file.path) && (
                <button
                  type="button"
                  onClick={() => onHtmlPreview(file.path)}
                  className="p-1 mr-1 hover:bg-surface-hover rounded text-text-tertiary hover:text-text-primary"
                  title={`Preview ${file.name}`}
                  aria-label={`Preview ${file.name}`}
                >
                  <Eye className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
          {getFilteredFiles().length === 0 && (
            <div className="p-4 text-[12px] text-text-secondary">No matching files</div>
          )}
        </div>
      )}
      {/* Tree view: always rendered so the async data loader stays active and
          populates the cache. Hidden (not unmounted) when search is active. */}
      <div
        {...tree.getContainerProps()}
        className={`overflow-auto outline-none ${searchQuery ? 'hidden' : 'flex-1'}`}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, file: null });
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOverPath('');
          e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-pane-file-paths') ? 'move' : 'copy';
        }}
        onDragLeave={(e) => {
          if (!containsEventTarget(e.currentTarget, e.relatedTarget)) setDragOverPath(null);
        }}
        onDrop={(e) => handleInternalDrop(e, '')}
      >
        {tree.getItems().map((item: ItemInstance<FileItem>) => {
          const data = item.getItemData();
          if (!data || item.getId() === ROOT_ID) return null;

          const isFolder = data.isDirectory;
          const level = item.getItemMeta().level;
          const isExpanded = item.isExpanded();
          const isItemSelected = item.isSelected();
          const isOpenFile = selectedPath === data.path && !isFolder;
          const treeItemProps = item.getProps();

          return (
            <div
              key={item.getId()}
              {...treeItemProps}
              role={treeItemProps.role}
              ref={(element) => {
                if (element) itemElementRefs.current.set(data.path, element);
                else itemElementRefs.current.delete(data.path);
              }}
              className={`group mx-2 flex min-h-7 w-[calc(100%-1rem)] cursor-pointer items-center rounded-md px-2 py-1 hover:bg-surface-hover ${
                isItemSelected ? 'bg-surface-selected' : ''
              } ${
                isOpenFile && !isItemSelected ? 'bg-surface-hover/60' : ''
              } ${
                dragOverPath === data.path ? 'ring-1 ring-interactive bg-interactive/10' : ''
              }`}
              style={{ paddingLeft: `${level * 16 + 8}px` }}
              draggable
              onDragStart={(e) => {
                const files = getSelectedFilesForAction(data);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('application/x-pane-file-paths', JSON.stringify(files.map(file => file.path)));
                e.dataTransfer.setData('text/plain', files.map(file => file.path).join('\n'));
              }}
              onDragOver={(e) => {
                if (!isFolder) return;
                e.preventDefault();
                e.stopPropagation();
                setDragOverPath(data.path);
                e.dataTransfer.dropEffect = e.dataTransfer.types.includes('application/x-pane-file-paths') ? 'move' : 'copy';
              }}
              onDragLeave={(e) => {
                if (!containsEventTarget(e.currentTarget, e.relatedTarget)) setDragOverPath(null);
              }}
              onDrop={(e) => {
                if (!isFolder) return;
                handleInternalDrop(e, data.path);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (e.metaKey || e.ctrlKey) {
                  item.toggleSelect();
                } else if (e.shiftKey) {
                  item.selectUpTo(false);
                } else {
                  item.select();
                }
                if (isFolder) {
                  if (isExpanded) item.collapse();
                  else item.expand();
                } else {
                  onFileSelect(data);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (isFolder) {
                    if (isExpanded) item.collapse();
                    else item.expand();
                  } else {
                    onFileSelect(data);
                  }
                }
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                if (!isFolder) onFileOpen?.(data);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!item.isSelected()) item.select();
                setContextMenu({ x: e.clientX, y: e.clientY, file: data });
              }}
            >
              {isFolder ? (
                <>
                  {isExpanded ? (
                    <ChevronDown className="mr-1 h-3.5 w-3.5 text-text-tertiary" />
                  ) : (
                    <ChevronRight className="mr-1 h-3.5 w-3.5 text-text-tertiary" />
                  )}
                  <Folder className="mr-2 h-3.5 w-3.5 text-text-tertiary" />
                </>
              ) : (
                <>
                  <div className="mr-1 h-3.5 w-3.5" />
                  <File className="mr-2 h-3.5 w-3.5 text-text-tertiary" />
                </>
              )}
              {renamingPath === data.path ? (
                <input
                  autoFocus
                  value={renamingValue}
                  onChange={(e) => setRenamingValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename(data, renamingValue);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      skipRenameCommitRef.current = true;
                      setRenamingPath(null);
                    }
                  }}
                  onBlur={() => {
                    if (skipRenameCommitRef.current) {
                      skipRenameCommitRef.current = false;
                      return;
                    }
                    commitRename(data, renamingValue);
                  }}
                  className="min-w-0 flex-1 rounded border border-border-primary bg-surface-primary px-1 py-0.5 text-[12px] text-text-primary focus:outline-none"
                />
              ) : (
                <span className="flex-1 truncate text-[12px] text-text-primary">{data.name}</span>
              )}
              {isFolder && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    filesCacheRef.current.delete(data.path);
                    item.invalidateChildrenIds();
                  }}
                  className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 p-1 hover:bg-surface-hover rounded text-text-tertiary hover:text-text-primary"
                  title="Refresh folder"
                >
                  <RefreshCw className="w-3 h-3" />
                </button>
              )}
              {!isFolder && isHtmlFile(data.path) && renamingPath !== data.path && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onHtmlPreview(data.path);
                  }}
                  className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 hover:bg-surface-hover rounded text-text-tertiary hover:text-text-primary"
                  title={`Preview ${data.name}`}
                  aria-label={`Preview ${data.name}`}
                >
                  <Eye className="w-3 h-3" />
                </button>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(data);
                }}
                className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 p-1 hover:bg-surface-hover rounded ml-1"
                title={`Delete ${isFolder ? 'folder' : 'file'}`}
              >
                <Trash2 className="w-3 h-3 text-status-error" />
              </button>
            </div>
          );
        })}
      </div>
      <TerminalPopover
        visible={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        onClose={() => setContextMenu(null)}
        className="w-60"
      >
        <PopoverButton onClick={() => openCreateDialog('file', contextMenu?.file ?? null)}>
          <span className="flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New File
          </span>
        </PopoverButton>
        <PopoverButton onClick={() => openCreateDialog('folder', contextMenu?.file ?? null)}>
          <span className="flex items-center gap-2">
            <FolderPlus className="w-4 h-4" />
            New Folder
          </span>
        </PopoverButton>
        {contextMenu?.file && (
          <>
            <div className="my-1 border-t border-border-primary" />
            <PopoverButton onClick={() => { if (contextMenu.file) startRename(contextMenu.file); }}>
              <span className="flex items-center gap-2">
                <Pencil className="w-4 h-4" />
                Rename
              </span>
            </PopoverButton>
            <PopoverButton onClick={() => { if (contextMenu.file) handleSetClipboard(contextMenu.file, 'copy'); }}>
              <span className="flex items-center gap-2">
                <Clipboard className="w-4 h-4" />
                Copy
              </span>
            </PopoverButton>
            <PopoverButton onClick={() => { if (contextMenu.file) handleSetClipboard(contextMenu.file, 'cut'); }}>
              <span className="flex items-center gap-2">
                <Clipboard className="w-4 h-4" />
                Cut
              </span>
            </PopoverButton>
            <PopoverButton onClick={() => { if (contextMenu.file) { handleDuplicate(contextMenu.file); setContextMenu(null); } }}>
              <span className="flex items-center gap-2">
                <CopyPlus className="w-4 h-4" />
                Duplicate
              </span>
            </PopoverButton>
          </>
        )}
        <PopoverButton disabled={!clipboard} onClick={() => handlePaste(contextMenu?.file ?? null)}>
          <span className="flex items-center gap-2">
            <ClipboardPaste className="w-4 h-4" />
            Paste
          </span>
        </PopoverButton>
        {contextMenu?.file && (
          <>
            <div className="my-1 border-t border-border-primary" />
            <PopoverButton onClick={handleCopyRelativePath}>
              <span className="flex items-center gap-2">
                <Copy className="w-4 h-4" />
                Copy Relative Path
              </span>
            </PopoverButton>
            <PopoverButton onClick={handleCopyPath}>
              <span className="flex items-center gap-2">
                <Copy className="w-4 h-4" />
                Copy Absolute Path
              </span>
            </PopoverButton>
            <PopoverButton
              onClick={handleRevealInFileManager}
              disabled={isRemoteMode}
              title={isRemoteMode ? 'Only available in local mode' : undefined}
            >
              <span className="flex items-center gap-2">
                <FolderOpen className="w-4 h-4" />
                {revealLabel}
                {isRemoteMode ? ' (local only)' : ''}
              </span>
            </PopoverButton>
            <div className="my-1 border-t border-border-primary" />
            <PopoverButton variant="danger" onClick={() => { if (contextMenu.file) { handleDelete(contextMenu.file); setContextMenu(null); } }}>
              <span className="flex items-center gap-2">
                <Trash2 className="w-4 h-4" />
                Move to Trash
              </span>
            </PopoverButton>
          </>
        )}
      </TerminalPopover>
    </div>
  );
}

interface FileEditorProps {
  sessionId: string;
  initialState?: ExplorerPanelState;
  onStateChange?: (state: Partial<ExplorerPanelState>) => void;
  /** False while the tree is mounted but hidden: its window-level shortcuts stay off. */
  shortcutsActive?: boolean;
}

/**
 * The Files inspector: a file tree whose clicks open center editor tabs.
 * Single-click previews, double-click pins (VS Code semantics); the row of
 * the active editor tab's file is highlighted.
 */
export function FileEditor({ sessionId, initialState, onStateChange, shortcutsActive = true }: FileEditorProps) {
  const [error, setError] = useState<string | null>(null);
  const pendingFocusPathRef = useRef<string | null>(null);

  const activeEditorPath = usePanelStore((state) => {
    const activeId = state.activePanels[sessionId];
    const active = (state.panels[sessionId] || []).find((panel) => panel.id === activeId);
    return active ? editorPanelState(active)?.filePath ?? null : null;
  });

  const openFile = useCallback(async (file: FileItem | null, pin: boolean) => {
    if (!file || file.isDirectory) return;
    setError(null);
    try {
      await openFileInEditor({ sessionId, filePath: file.path, pin });
      if (pendingFocusPathRef.current === file.path) {
        pendingFocusPathRef.current = null;
        window.dispatchEvent(new CustomEvent('editor-panel:reveal', {
          detail: { filePath: file.path, cursorPosition: { line: 1, column: 1 } },
        }));
      }
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : 'Failed to open file');
    }
  }, [sessionId]);

  const handleFileSelect = useCallback((file: FileItem | null) => { void openFile(file, false); }, [openFile]);
  const handleFileOpen = useCallback((file: FileItem) => { void openFile(file, true); }, [openFile]);

  const previewHtmlFile = useCallback(async (filePath: string) => {
    setError(null);
    try {
      await previewHtmlFileInBrowser(sessionId, filePath);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : 'Failed to preview HTML file');
    }
  }, [sessionId]);

  const handleTreeStateChange = useCallback((treeState: { expandedDirs: string[]; searchQuery: string; showSearch: boolean }) => {
    onStateChange?.(treeState);
  }, [onStateChange]);

  return (
    <div className="pane-explorer-tree h-full w-full min-w-0 flex flex-col overflow-hidden bg-surface-secondary">
      {error && (
        <div role="alert" className="px-3 py-1.5 bg-status-error/20 text-status-error text-xs">
          {error}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <HeadlessFileTree
          sessionId={sessionId}
          onFileSelect={handleFileSelect}
          onFileOpen={handleFileOpen}
          onFileCreateSelect={(filePath) => {
            pendingFocusPathRef.current = filePath;
          }}
          selectedPath={activeEditorPath}
          initialExpandedDirs={initialState?.expandedDirs}
          initialSearchQuery={initialState?.searchQuery}
          initialShowSearch={initialState?.showSearch}
          onTreeStateChange={handleTreeStateChange}
          onHtmlPreview={previewHtmlFile}
          shortcutsActive={shortcutsActive}
        />
      </div>
    </div>
  );
}
