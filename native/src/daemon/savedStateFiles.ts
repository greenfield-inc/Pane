import { Directory, File, Paths } from 'expo-file-system';

import type { SavedStateFiles } from './savedState';

/**
 * One JSON file per machine in the app's cache folder, which iCloud and Android backups leave
 * out: the files hold approval text and project paths. Saved state is a convenience, so a failed
 * read or write is skipped, and the system may clear the folder at any time.
 */
const folder = new Directory(Paths.cache, 'saved-state');

export const savedStateFiles: SavedStateFiles = {
  read: name => {
    try {
      const file = new File(folder, name);
      return file.exists ? file.textSync() : null;
    } catch {
      return null;
    }
  },
  write: (name, text) => {
    try {
      folder.create({ intermediates: true, idempotent: true });
      new File(folder, name).write(text);
    } catch {
      // The next change writes again.
    }
  },
  remove: name => {
    try {
      const file = new File(folder, name);
      if (file.exists) file.delete();
    } catch {
      // Nothing to delete.
    }
  },
  list: () => {
    try {
      return folder.exists ? folder.list().map(entry => entry.name) : [];
    } catch {
      return [];
    }
  },
};
