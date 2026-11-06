import { useCallback, useEffect, useReducer, useRef } from 'react';
import { ArrowUp, Folder, FolderGit2, FolderOpen, FolderPlus } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from './ui/Modal';
import { Button } from './ui/Button';
import { EnhancedInput } from './ui/EnhancedInput';
import { API } from '../utils/api';
import { withHostLabel, type ActiveHost } from '../utils/hostRepoActions';
import {
  hostFolderBrowserReducer,
  initialHostFolderBrowserState,
  visibleEntries,
  type HostFolderBrowserState,
} from '../utils/hostFolderBrowserState';

interface HostFolderBrowserViewProps {
  hostName: string;
  state: HostFolderBrowserState;
  /** New project and clone destinations may create a folder; Open never does. */
  allowCreate: boolean;
  onOpenFolder: (path: string) => void;
  onUp: () => void;
  onToggleHidden: () => void;
  onStartNewFolder: () => void;
  onNewFolderNameChange: (name: string) => void;
  onCreateFolder: () => void;
  onCancelNewFolder: () => void;
}

export function HostFolderBrowserView({
  hostName,
  state,
  allowCreate,
  onOpenFolder,
  onUp,
  onToggleHidden,
  onStartNewFolder,
  onNewFolderNameChange,
  onCreateFolder,
  onCancelNewFolder,
}: HostFolderBrowserViewProps) {
  const { listing, loading, error, showHidden, newFolderName } = state;
  const entries = listing ? visibleEntries(listing, showHidden) : [];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<ArrowUp className="h-4 w-4" />}
          onClick={onUp}
          disabled={loading || !listing?.parent}
        >
          Up
        </Button>
        <div
          aria-label="Current folder"
          className="min-w-0 flex-1 truncate rounded-md bg-surface-secondary px-3 py-1.5 font-mono text-sm text-text-primary"
          title={listing?.path}
        >
          {listing?.path ?? `Loading ${hostName}…`}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-text-secondary">
          <input type="checkbox" checked={showHidden} onChange={onToggleHidden} />
          Show hidden folders
        </label>
        {allowCreate && newFolderName === null && (
          <Button
            variant="ghost"
            size="sm"
            icon={<FolderPlus className="h-4 w-4" />}
            onClick={onStartNewFolder}
            disabled={loading || !listing}
          >
            New folder
          </Button>
        )}
      </div>

      {allowCreate && newFolderName !== null && (
        <div className="flex items-center gap-2">
          <EnhancedInput
            type="text"
            aria-label="New folder name"
            value={newFolderName}
            onChange={(event) => onNewFolderNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onCreateFolder();
            }}
            placeholder="Folder name"
            size="sm"
            fullWidth
            autoFocus
          />
          <Button variant="primary" size="sm" onClick={onCreateFolder} disabled={loading || !newFolderName.trim()}>
            Create folder
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancelNewFolder}>
            Cancel
          </Button>
        </div>
      )}

      {error && (
        <div role="alert" className="text-sm text-status-error">
          {error}
        </div>
      )}

      <div className="h-72 overflow-y-auto rounded-md border border-border-secondary">
        {listing && entries.length === 0 && !loading && (
          <p className="px-3 py-2 text-sm text-text-tertiary">No folders here.</p>
        )}
        {entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            aria-label={entry.isGitRepo ? `${entry.name}, git repo` : entry.name}
            onClick={() => onOpenFolder(entry.path)}
            disabled={loading}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-primary hover:bg-surface-hover disabled:opacity-60"
          >
            {entry.isGitRepo
              ? <FolderGit2 className="h-4 w-4 flex-shrink-0 text-interactive" aria-hidden="true" />
              : <Folder className="h-4 w-4 flex-shrink-0 text-text-tertiary" aria-hidden="true" />}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {entry.isGitRepo && (
              <span aria-hidden="true" className="flex-shrink-0 rounded bg-surface-tertiary px-1.5 py-0.5 text-xs text-text-secondary">
                git repo
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

interface HostFolderBrowserProps {
  isOpen: boolean;
  host: ActiveHost;
  allowCreate: boolean;
  onSelect: (path: string) => void;
  onClose: () => void;
}

/**
 * Folder picker for a remote host. The native dialog only sees this computer,
 * so this lists the host's folders through the daemon, starting at its home.
 */
export function HostFolderBrowser({ isOpen, host, allowCreate, onSelect, onClose }: HostFolderBrowserProps) {
  const [state, dispatch] = useReducer(hostFolderBrowserReducer, initialHostFolderBrowserState);
  // Only the latest navigation may land; a slow earlier listing is dropped.
  const requestRef = useRef(0);

  const load = useCallback(async (path: string) => {
    const request = ++requestRef.current;
    dispatch({ type: 'load-start' });
    try {
      const response = await API.hostFs.browseDirectories(withHostLabel(host, { path, showHidden: true }));
      if (request !== requestRef.current) return;
      if (response.success && response.data) {
        dispatch({ type: 'load-success', listing: response.data });
      } else {
        dispatch({ type: 'failure', error: response.error ?? `Could not list ${path} on ${host.name}.` });
      }
    } catch (error) {
      if (request !== requestRef.current) return;
      dispatch({ type: 'failure', error: error instanceof Error ? error.message : `Could not list ${path} on ${host.name}.` });
    }
  }, [host]);

  useEffect(() => {
    if (!isOpen) return;
    void load('~');
    return () => {
      requestRef.current += 1;
    };
  }, [isOpen, load]);

  const createFolder = async () => {
    const name = state.newFolderName?.trim();
    if (!state.listing || !name) return;
    dispatch({ type: 'load-start' });
    try {
      const response = await API.hostFs.createDirectory(withHostLabel(host, { parent: state.listing.path, name }));
      if (response.success && response.data) {
        await load(response.data.path);
      } else {
        dispatch({ type: 'failure', error: response.error ?? `Could not create ${name} on ${host.name}.` });
      }
    } catch (error) {
      dispatch({ type: 'failure', error: error instanceof Error ? error.message : `Could not create ${name} on ${host.name}.` });
    }
  };

  const { listing, loading } = state;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <ModalHeader title={`Choose a folder on ${host.name}`} icon={<FolderOpen className="h-5 w-5" />} />
      <ModalBody>
        <HostFolderBrowserView
          hostName={host.name}
          state={state}
          allowCreate={allowCreate}
          onOpenFolder={(path) => void load(path)}
          onUp={() => {
            if (listing?.parent) void load(listing.parent);
          }}
          onToggleHidden={() => dispatch({ type: 'toggle-hidden' })}
          onStartNewFolder={() => dispatch({ type: 'new-folder-start' })}
          onNewFolderNameChange={(name) => dispatch({ type: 'new-folder-name', name })}
          onCreateFolder={() => void createFolder()}
          onCancelNewFolder={() => dispatch({ type: 'new-folder-cancel' })}
        />
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" size="md" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="md"
          disabled={loading || !listing}
          onClick={() => {
            if (listing) onSelect(listing.path);
          }}
        >
          Select this folder
        </Button>
      </ModalFooter>
    </Modal>
  );
}
