export interface PaneNameBranchInfo {
  name: string;
  isCurrent: boolean;
  hasWorktree: boolean;
  isRemote: boolean;
}

export function sanitizePaneName(name: string, options: { trim?: boolean } = {}): string {
  const { trim = true } = options;
  const sanitized = name
    .replace(/[~^:?*[\]\\/]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '');

  return trim ? sanitized.trim() : sanitized;
}

/** The branch a new Pane starts from by default: the remote main branch, else the checked-out one. */
export function defaultBaseBranch(branches: PaneNameBranchInfo[]): string | undefined {
  const remoteMain = branches.find(branch => branch.isRemote && (branch.name === 'origin/main' || branch.name === 'origin/master'));
  return (remoteMain ?? branches.find(branch => branch.isCurrent))?.name;
}

export function generatePaneName(
  branchName: string,
  existingNames: Set<string>,
  branches: PaneNameBranchInfo[] = [],
): string {
  const baseName = sanitizePaneName(branchName.replace(/^[^/]+\//, '')) || 'pane';
  const unavailableNames = new Set(existingNames);

  for (const branch of branches) {
    if (branch.isRemote || (!branch.isCurrent && !branch.hasWorktree)) continue;
    const unavailableBranchName = sanitizePaneName(branch.name.replace(/^[^/]+\//, ''));
    if (unavailableBranchName) {
      unavailableNames.add(unavailableBranchName);
    }
  }

  if (!unavailableNames.has(baseName)) {
    return baseName;
  }

  let suffix = 1;
  while (unavailableNames.has(`${baseName}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseName}-${suffix}`;
}

/**
 * A Pane name from a task description: its first three words longer than two
 * letters, kebab-cased, as main names a Pane created from a prompt alone.
 * "Add a dark mode toggle" gives "add-dark-mode". Empty when nothing qualifies.
 */
export function taskPaneName(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2)
    .slice(0, 3)
    .join('-');
}
