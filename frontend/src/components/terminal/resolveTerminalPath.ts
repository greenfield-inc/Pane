export interface TerminalFilePath {
  absolutePath: string | null;
  relativePath: string | null;
}

function normalize(path: string): string {
  const root = path.match(/^(?:[A-Za-z]:|\/\/[^/]+\/[^/]+|\/)/)?.[0] ?? '';
  const segments: string[] = [];
  for (const part of path.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return `${root.replace(/\/$/, '')}/${segments.join('/')}`;
}

/** Resolve terminal spelling without guessing the user's home or crossing worktrees. */
export function resolveTerminalPath(
  text: string,
  workingDirectory: string,
  homeDirectory?: string,
): TerminalFilePath {
  let input = text.trim().replace(/:\d+(?::\d+)?$/, '').replace(/\\/g, '/');
  const directory = workingDirectory.replace(/\\/g, '/');
  const wsl = directory.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)/i);
  if (input === '~' || input.startsWith('~/')) {
    if (!homeDirectory) return { absolutePath: null, relativePath: null };
    input = homeDirectory.replace(/\\/g, '/') + input.slice(1);
  }
  if (wsl && input.startsWith('/') && !input.startsWith('//')) {
    input = `${wsl[0]}${input}`;
  }
  const absolute = /^(?:[A-Za-z]:\/|\/)/.test(input);
  if (!absolute && !directory) return { absolutePath: null, relativePath: null };
  const resolved = normalize(absolute ? input : `${directory}/${input}`);
  const base = normalize(directory).replace(/\/$/, '');
  // WSL Linux filenames remain case-sensitive; native Windows filenames do not.
  const windows = /^[A-Za-z]:|^\/\//.test(resolved);
  const compare = (value: string) => windows && !wsl ? value.toLowerCase() : value;
  const relativePath = directory && compare(resolved).startsWith(`${compare(base)}/`)
    ? resolved.slice(base.length + 1) : null;
  return { absolutePath: windows ? resolved.replace(/\//g, '\\') : resolved, relativePath };
}
