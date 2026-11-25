/** The Profiles tab's file tree (T-63 PR 5): a plugin's files as rows, folders before their files. */

/** A plugin's sections in the order the tree shows them, with what each holds. */
const SECTIONS: [string, string][] = [
  ['profiles', 'Profile settings'],
  ['agents', 'Identity & subagents'],
  ['instructions', 'Instructions'],
  ['skills', 'Skills'],
  ['references', 'References'],
];

export type FileTreeRow =
  | { kind: 'folder'; path: string; name: string; depth: number; hint?: string }
  | { kind: 'file'; path: string; name: string; depth: number };

interface Folder {
  folders: Map<string, Folder>;
  files: string[];
}

function folderOf(paths: string[]): Folder {
  const root: Folder = { folders: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: [] };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.files.push(path);
  }
  return root;
}

function rowsOf(folder: Folder, prefix: string, depth: number, rows: FileTreeRow[]): void {
  for (const [name, child] of [...folder.folders].sort(([a], [b]) => a.localeCompare(b))) {
    const path = `${prefix}${name}`;
    rows.push({ kind: 'folder', path, name, depth });
    rowsOf(child, `${path}/`, depth + 1, rows);
  }
  for (const file of [...folder.files].sort()) rows.push({ kind: 'file', path: file, name: file.slice(prefix.length), depth });
}

/** plugin.yaml, then each section's folder and its files, in a fixed section order. */
export function fileTreeRows(files: string[]): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  if (files.includes('plugin.yaml')) rows.push({ kind: 'file', path: 'plugin.yaml', name: 'plugin.yaml', depth: 0 });
  for (const [section, hint] of SECTIONS) {
    const inside = files.filter(file => file.startsWith(`${section}/`));
    if (!inside.length) continue;
    rows.push({ kind: 'folder', path: section, name: section, depth: 0, hint });
    const tree = folderOf(inside).folders.get(section);
    if (tree) rowsOf(tree, `${section}/`, 1, rows);
  }
  return rows;
}
