import { Directory, File, Paths } from 'expo-file-system';

import type { SavedStateFiles } from './savedState';

/** One JSON file per machine, with iOS's default file protection. Saved state is a convenience: a failed read or write is skipped. */
const folder = new Directory(Paths.document, 'saved-state');
const fileOf = (machineId: string) => new File(folder, `${encodeURIComponent(machineId)}.json`);

export const savedStateFiles: SavedStateFiles = {
  read: machineId => {
    try {
      const file = fileOf(machineId);
      return file.exists ? file.textSync() : null;
    } catch {
      return null;
    }
  },
  write: (machineId, text) => {
    try {
      folder.create({ intermediates: true, idempotent: true });
      fileOf(machineId).write(text);
    } catch {
      // The next change writes again.
    }
  },
  remove: machineId => {
    try {
      const file = fileOf(machineId);
      if (file.exists) file.delete();
    } catch {
      // Nothing to delete.
    }
  },
};
