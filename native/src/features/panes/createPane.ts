import type { AgentLaunchPresetId } from '@shared/constants/agentLaunchPresets';
import type { RunpanePaneCreateRequest, RunpanePaneCreateResult } from '@shared/types/runpaneOrchestration';
import { generatePaneName, sanitizePaneName, type PaneNameBranchInfo } from '@shared/utils/paneName';

/** One entry of `projects:list-branches`. */
export type BranchInfo = PaneNameBranchInfo;

/** Same default as the PWA: the remote main branch, else the checked-out one. */
export function defaultBaseBranch(branches: BranchInfo[]): string | undefined {
  const remoteMain = branches.find(branch => branch.isRemote && (branch.name === 'origin/main' || branch.name === 'origin/master'));
  return (remoteMain ?? branches.find(branch => branch.isCurrent) ?? branches[0])?.name;
}

export function filterBranches(branches: BranchInfo[], query: string): BranchInfo[] {
  const needle = query.trim().toLowerCase();
  const matches = needle ? branches.filter(branch => branch.name.toLowerCase().includes(needle)) : branches;
  return [...matches.filter(branch => branch.isRemote), ...matches.filter(branch => !branch.isRemote)];
}

export function suggestPaneName(baseBranch: string, existingNames: string[], branches: BranchInfo[]): string {
  return generatePaneName(baseBranch, new Set(existingNames), branches);
}

export interface CreatePaneDraft {
  projectId: number | undefined;
  name: string;
  baseBranch: string | undefined;
  agent: AgentLaunchPresetId;
}

/** Builds the `runpane:panes:create` request, which creates the worktree and starts the agent in one call. */
export function buildCreatePaneRequest(draft: CreatePaneDraft): { request: RunpanePaneCreateRequest } | { error: string } {
  const name = sanitizePaneName(draft.name);
  if (draft.projectId === undefined) return { error: 'Choose a repository.' };
  if (!name) return { error: 'Give the pane a name.' };
  if (!draft.baseBranch) return { error: 'Choose a base branch.' };
  return {
    request: {
      repo: { id: draft.projectId },
      // `pinned` means favorite; runpane defaults it on, the app starts panes unfavorited.
      panes: [{ name, baseBranch: draft.baseBranch, pinned: false, tool: { agent: draft.agent } }],
    },
  };
}

export function paneFromCreateResult(result: RunpanePaneCreateResult): { paneId: string; panelId?: string } {
  const [item] = result.items;
  if (!item) throw new Error('The host did not create a pane.');
  if (!item.ok) throw new Error('error' in item ? item.error.message : 'The host could not create the pane.');
  const paneId = item.paneId ?? item.sessionId;
  if (!paneId) throw new Error('The host did not return the new pane.');
  return { paneId, panelId: item.panelId };
}
