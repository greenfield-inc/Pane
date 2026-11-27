import { create } from 'zustand';
import type { MachineMirrorListing } from '../../../shared/types/machineMirror';

/**
 * The desktop mirror as the renderer knows it (T-116 PR 6): each of the owner's mirrored machines,
 * how current it is, and the revision of each Session it holds. Read from main's memory
 * (`machine-mirror:list`) when first needed and again on every `machine-mirror:changed`. Only the
 * person's own machines are ever listed (D-5, D-500), so a listed machine's rows show instantly.
 */
interface MachineMirrorStoreState {
  listings: Record<string, MachineMirrorListing>;
}

export const useMachineMirrorStore = create<MachineMirrorStoreState>(() => ({ listings: {} }));

let following = false;
let reading: Promise<void> | undefined;
let again = false;

function readListings(): Promise<void> {
  const api = window.electronAPI?.machineMirror;
  if (!api) return Promise.resolve();
  if (reading) {
    again = true;
    return reading;
  }
  reading = api.list()
    .then(listings => {
      useMachineMirrorStore.setState({ listings: Object.fromEntries(listings.map(listing => [listing.state.machineId, listing])) });
    })
    .catch(error => console.warn('[Machine mirror] Could not list the mirrored machines:', error))
    .finally(() => {
      reading = undefined;
      if (again) {
        again = false;
        void readListings();
      }
    });
  return reading;
}

/** Starts following the mirror, once per window; later calls do nothing. */
export function followMachineMirror(): void {
  const api = window.electronAPI?.machineMirror;
  if (following || !api) return;
  following = true;
  api.onChanged(() => { void readListings(); });
  void readListings();
}

/** A machine's listing, when it is mirrored. */
export function mirrorListing(machineId: string): MachineMirrorListing | undefined {
  return useMachineMirrorStore.getState().listings[machineId];
}
