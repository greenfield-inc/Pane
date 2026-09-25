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
