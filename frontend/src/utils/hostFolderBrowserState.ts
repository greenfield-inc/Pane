import type { BrowseDirectoriesResult, HostDirectoryEntry } from '../../../shared/types/hostPaths';

export interface HostFolderBrowserState {
  listing: BrowseDirectoriesResult | null;
  loading: boolean;
  error: string | null;
  showHidden: boolean;
  /** The name being typed for a new folder; null while not creating one. */
  newFolderName: string | null;
}

type HostFolderBrowserAction =
  | { type: 'load-start' }
  | { type: 'load-success'; listing: BrowseDirectoriesResult }
  | { type: 'failure'; error: string }
  | { type: 'toggle-hidden' }
  | { type: 'new-folder-start' }
  | { type: 'new-folder-name'; name: string }
  | { type: 'new-folder-cancel' };

export const initialHostFolderBrowserState: HostFolderBrowserState = {
  listing: null,
  loading: false,
  error: null,
  showHidden: false,
  newFolderName: null,
};

export function hostFolderBrowserReducer(
  state: HostFolderBrowserState,
  action: HostFolderBrowserAction,
): HostFolderBrowserState {
  switch (action.type) {
    case 'load-start':
      return { ...state, loading: true, error: null };
    case 'load-success':
      return { ...state, listing: action.listing, loading: false, error: null, newFolderName: null };
    case 'failure':
      // Keep the last good listing so the user can pick another folder.
      return { ...state, loading: false, error: action.error };
    case 'toggle-hidden':
      return { ...state, showHidden: !state.showHidden };
    case 'new-folder-start':
      return { ...state, newFolderName: '', error: null };
    case 'new-folder-name':
      return { ...state, newFolderName: action.name };
    case 'new-folder-cancel':
      return { ...state, newFolderName: null, error: null };
  }
}

/** The host lists every subfolder with a hidden flag; dot folders show on request. */
export function visibleEntries(listing: BrowseDirectoriesResult, showHidden: boolean): HostDirectoryEntry[] {
  return showHidden ? listing.entries : listing.entries.filter((entry) => !entry.isHidden);
}
