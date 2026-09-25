import type { LucideIcon } from 'lucide-react';
import type { GitCommands, GitStatus } from '../types/session';
import { formatKeyDisplay } from '../utils/hotkeyUtils';
import { Button } from './ui/Button';
import { Kbd } from './ui/Kbd';
import { Tooltip } from './ui/Tooltip';

interface GitBranchAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled: boolean;
  variant: 'default' | 'success' | 'danger';
  description: string;
  shortcut?: string;
  disabledReason?: string;
}

interface DetailPanelGitActionsProps {
  actions?: GitBranchAction[];
  isMerging?: boolean;
  gitCommands?: GitCommands;
  gitStatus?: GitStatus;
}

type ActionRow =
  | { type: 'single'; action: GitBranchAction }
  | { type: 'pair'; left: GitBranchAction; right: GitBranchAction };

const sidebarButtonClass = 'w-full !h-7 justify-start !rounded-md !px-2 !py-0 !text-[12px] !font-medium !text-text-secondary hover:!bg-surface-hover hover:!text-text-primary focus:!ring-0 focus-visible:!ring-2';

function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function actionTooltip(action: GitBranchAction, disabled: boolean) {
  const message = disabled ? action.disabledReason ?? action.description : action.description;
  return (
    <div className="space-y-1">
      {message && <div>{disabled ? `Unavailable: ${message}` : message}</div>}
      {action.shortcut && (
        <div className="flex items-center gap-2 text-text-tertiary">
          <span>Shortcut</span>
          <Kbd size="xs" variant="muted">{formatKeyDisplay(action.shortcut)}</Kbd>
        </div>
      )}
    </div>
  );
}

function buildRows(actions: GitBranchAction[]): ActionRow[] {
  const byId = (id: string) => actions.find(action => action.id === id);
  const partnerIds = new Set(['commit', 'stash-pop', 'push', 'rebase-to-main']);
  const rows: ActionRow[] = [];

  for (const action of actions) {
    const partnerId = action.id === 'fetch' ? 'commit'
      : action.id === 'stash' ? 'stash-pop'
        : action.id === 'pull' ? 'push'
          : action.id === 'rebase-from-main' ? 'rebase-to-main'
            : undefined;
    const partner = partnerId ? byId(partnerId) : undefined;
    if (partner) {
      rows.push({ type: 'pair', left: action, right: partner });
    } else if (!partnerIds.has(action.id)) {
      rows.push({ type: 'single', action });
    }
  }
  return rows;
}

function ActionPair({
  left,
  right,
  isMerging,
  gitCommands,
  gitStatus,
  fetchedAgo,
}: {
  left: GitBranchAction;
  right: GitBranchAction;
  isMerging?: boolean;
  gitCommands?: GitCommands;
  gitStatus?: GitStatus;
  fetchedAgo: string | null;
}) {
  const isRebaseMerge = left.id === 'rebase-from-main';
  const mainBranchName = (gitCommands?.comparisonBaseBranch || 'main').split('/').pop() || 'main';
  const mainBranch = mainBranchName.length > 12 ? `${mainBranchName.slice(0, 12)}…` : mainBranchName;
  const pairButtonClass = 'flex-1 !min-h-7 justify-start !rounded-md !px-2 !py-0 !text-[12px] !font-medium !text-text-secondary hover:!bg-surface-hover hover:!text-text-primary focus:!ring-0 focus-visible:!ring-2';
  const pairIconClass = 'mr-1.5 h-3.5 w-3.5 flex-shrink-0';
  const branchName = gitCommands?.currentBranch?.trim() || 'branch';
  const shortBranch = branchName.length > 6 ? `${branchName.slice(0, 6)}…` : branchName;

  return (
    <div className="flex gap-0.5 [&>*]:min-w-0 [&>*]:flex-1">
      <Tooltip content={actionTooltip(left, left.disabled || !!isMerging)} side="left">
        <Button variant="ghost" size="sm" className={pairButtonClass} onClick={left.onClick} disabled={left.disabled || isMerging}>
          <left.icon className={pairIconClass} />
          {isRebaseMerge ? (
            <span className="flex flex-col items-start leading-tight">
              <span>Rebase</span>
              <span className="text-[10px] text-text-tertiary">from {mainBranch}</span>
            </span>
          ) : left.id === 'fetch' && fetchedAgo ? (
            <span className="flex flex-col items-start leading-tight min-w-0">
              <span>{left.label}</span>
              <span className="text-[10px] text-text-tertiary">{fetchedAgo}</span>
            </span>
          ) : (
            <>
              <span>{left.label}</span>
              {left.id === 'pull' && !!gitStatus?.behind && (
                <span className="text-[10px] text-status-warning font-medium ml-1">&darr;{gitStatus.behind}</span>
              )}
            </>
          )}
        </Button>
      </Tooltip>
      <Tooltip content={actionTooltip(right, right.disabled || !!isMerging)} side="left">
        <Button variant="ghost" size="sm" className={pairButtonClass} onClick={right.onClick} disabled={right.disabled || isMerging}>
          <right.icon className={pairIconClass} />
          {isRebaseMerge ? (
            <span className="flex flex-col items-start leading-tight">
              <span>Merge</span>
              <span className="text-[10px] text-text-tertiary">to {mainBranch}</span>
            </span>
          ) : right.id === 'commit' ? (
            <span className="flex flex-col items-start leading-tight min-w-0">
              <span>{right.label}</span>
              <span className="text-[10px] text-text-tertiary truncate max-w-full">
                {gitStatus?.filesChanged
                  ? `${gitStatus.filesChanged} ${gitStatus.filesChanged === 1 ? 'file' : 'files'}`
                  : `to ${shortBranch}`}
              </span>
            </span>
          ) : (
            <>
              <span>{right.label}</span>
              {right.id === 'push' && !!gitStatus?.ahead && (
                <span className="text-[10px] text-status-success font-medium ml-1">&uarr;{gitStatus.ahead}</span>
              )}
            </>
          )}
        </Button>
      </Tooltip>
    </div>
  );
}

export function DetailPanelGitActions({ actions = [], isMerging, gitCommands, gitStatus }: DetailPanelGitActionsProps) {
  const fetchedAgo = gitStatus?.lastChecked ? formatTimeAgo(gitStatus.lastChecked) : null;
  return (
    <div className="px-2 pt-3 pb-1">
      <h3 className="mb-1 px-2 text-[10px] font-semibold uppercase leading-4 tracking-wider text-text-tertiary">Actions</h3>
      <div className="space-y-0.5">
        {buildRows(actions).map(row => row.type === 'pair' ? (
          <ActionPair
            key={`${row.left.id}-${row.right.id}`}
            left={row.left}
            right={row.right}
            isMerging={isMerging}
            gitCommands={gitCommands}
            gitStatus={gitStatus}
            fetchedAgo={fetchedAgo}
          />
        ) : (
          <Tooltip key={row.action.id} content={actionTooltip(row.action, row.action.disabled || !!isMerging)} side="left">
            <Button
              variant="ghost"
              size="sm"
              className={sidebarButtonClass}
              onClick={row.action.onClick}
              disabled={row.action.disabled || isMerging}
            >
              <row.action.icon className="mr-2 h-3.5 w-3.5 flex-shrink-0" />
              {row.action.id === 'fetch' && fetchedAgo ? (
                <span className="flex flex-col items-start leading-tight min-w-0">
                  <span>{row.action.label}</span>
                  <span className="text-[10px] text-text-tertiary">{fetchedAgo}</span>
                </span>
              ) : <span className="truncate">{row.action.label}</span>}
            </Button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
