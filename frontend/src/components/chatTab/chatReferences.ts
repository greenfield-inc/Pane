import { createContext } from 'react';

/** What a sent message's references can do: the tab's skill names, and opening a file. Without `openFile` files are marked, not clickable. */
export interface ChatReferences { skills: ReadonlySet<string>; openFile?: (path: string) => void }

export const ChatReferencesContext = createContext<ChatReferences>({ skills: new Set() });

/** A path written relative to the tab's folder `cwd`, as one relative to its Pane's `root`; undefined when it would leave the folder. */
export function referencedFile(file: string, cwd: string | undefined, root: string | undefined): string | undefined {
  const parts = file.split(/[\\/]/);
  if (parts.some(part => part === '..' || part === '') || /^~|^[a-zA-Z]:/.test(file)) return undefined;
  const path = parts.filter(part => part !== '.').join('/');
  if (!path) return undefined;
  const posix = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!cwd || !root || posix(cwd) === posix(root)) return path;
  return posix(cwd).startsWith(`${posix(root)}/`) ? `${posix(cwd).slice(posix(root).length + 1)}/${path}` : undefined;
}
