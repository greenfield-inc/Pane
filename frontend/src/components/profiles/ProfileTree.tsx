import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AlertTriangle, Asterisk, ChevronRight, FileText, Folder, LayoutTemplate, Repeat, SquareTerminal } from 'lucide-react';
import { agentLabel } from '../../../../shared/agents';
import type { ProfileSubagentNode, ProfileSummary, ProfileTreeNode } from '../../../../shared/types/profileEditor';
import { coverPlace, fileKey, isCoverPlace, useProfilesStore } from '../../stores/profilesStore';
import { cn } from '../../utils/cn';
import { ProfileAvatar } from './ProfileAvatar';
import { LINK_MODE_SHORT, LINK_MODE_TEXT, ancestorsOf, isExpandable, subagentLabel, subagentState, variantsText, visibleRows } from './profilePreview';
import { tabActionLabel, tabCommand, useTabPane } from './subagentTab';
import { isMac } from '../../utils/platformUtils';

/** The row key that opens a launch or process agent in a tab. */
const TAB_KEY = isMac() ? '⌘↩' : 'Ctrl+Enter';

/**
 * A linked agent's mark, always the 16 px box an avatar takes: its avatar, ↻ for a link back to an
 * agent above it, an asterisk for any agent of a plugin, a warning for a link that doesn't resolve.
 */
function SubagentMark({ node }: { node: ProfileSubagentNode }) {
  const state = subagentState(node);
  if (state === 'agent') return <ProfileAvatar profileRef={node.profile} agent={node.harness} size={16} />;
  const Icon = state === 'cycle' ? Repeat : state === 'any' ? Asterisk : AlertTriangle;
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" data-testid={`profiles-tree-mark-${state}`} aria-hidden="true">
      <Icon className={cn('h-3.5 w-3.5', state === 'error' ? 'text-status-warning' : 'text-text-tertiary')} />
    </span>
  );
}

/** The row's tooltip: what it is, how its parent runs it, its variants, or why it doesn't resolve. */
function subagentTooltip(node: ProfileSubagentNode): string {
  const state = subagentState(node);
  if (state === 'error') return `${node.label}: ${node.error ?? 'Agent Farm couldn’t find it.'}`;
  const what = state === 'cycle' ? `${node.agent}, already above on this path` : state === 'any' ? `Any agent in ${node.agent}` : node.agent;
  return [what, LINK_MODE_TEXT[node.mode], variantsText(node.variants, agentLabel)].filter(Boolean).join(' · ');
}

const ROW = 'mx-1.5 flex h-[27px] w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-md pr-2 text-left text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive';

/** The first file row showing `path`, depth first. */
function firstWithPath(tree: readonly ProfileTreeNode[], path: string): ProfileTreeNode | undefined {
  for (const node of tree) {
    if (node.kind === 'file' && node.path === path) return node;
    if (node.kind !== 'file') {
      const inside = firstWithPath(node.children, path);
      if (inside) return inside;
    }
  }
  return undefined;
}

/** Folders open when a profile is opened: its skills and subagents, as the design shows them. */
function initiallyOpen(tree: readonly ProfileTreeNode[]): Set<string> {
  return new Set(tree.filter(node => node.kind === 'folder' && (node.label === 'Skills' || node.label === 'Subagents')).map(node => node.id));
}

/**
 * The profile page's tree (T-63, build-6 feedback item 4): the cover page, then only this
 * profile's own files: its identity, instructions, skills, references, the subagents it calls with
 * their own files nested, and its settings. Folders and subagents open and close (click the
 * chevron, or ← →); clicking a subagent shows its own cover. ↑↓ move, Return shows a row.
 * Keyed by profile, so another profile opens with its own folders.
 */
export function ProfileTree({ plugin, profile, file, selectedId, onSelect, onOpenTab }: {
  plugin: string;
  profile: ProfileSummary;
  /** What the page shows: a file path, or a cover place. */
  file: string;
  /** The row last chosen, to tell apart a file that appears under two subagents. */
  selectedId: string | null;
  onSelect: (id: string | null, file: string) => void;
  /** Opens a launch or process agent in a tab (T-83 P4): its row's tab button, or ⌘↩ on the row. */
  onOpenTab: (node: ProfileSubagentNode) => void;
}) {
  const drafts = useProfilesStore(state => state.drafts);
  const pane = useTabPane();
  const [open, setOpen] = useState<Set<string>>(() => initiallyOpen(profile.tree));
  const treeRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => visibleRows(profile.tree, open), [open, profile.tree]);
  const coverId = isCoverPlace(file) ? file.slice('cover:'.length) : null;
  const selected = (node: ProfileTreeNode): boolean => {
    if (node.kind === 'subagent') return coverId === node.id;
    if (node.kind !== 'file' || node.path !== file) return false;
    return selectedId === null || selectedId === node.id || !rows.some(row => row.node.id === selectedId);
  };

  // The row on show stays visible: its folders open when it is shown (a file opened from a cover's
  // chip, or after New). Only then: closing its folder afterwards hides it and keeps it selected.
  useEffect(() => {
    const id = coverId || (selectedId ?? undefined) || firstWithPath(profile.tree, file)?.id;
    const trail = id ? ancestorsOf(profile.tree, id) : undefined;
    if (trail?.length) setOpen(current => (trail.every(item => current.has(item)) ? current : new Set([...current, ...trail])));
  }, [coverId, file, profile.tree, selectedId]);

  // Opening a profile (the parent keys this tree by profile) puts the keys in its tree, on the cover page.
  useEffect(() => { treeRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true }); }, []);

  const toggle = (id: string, to?: boolean) => setOpen(current => {
    const next = new Set(current);
    if (to ?? !next.has(id)) next.add(id);
    else next.delete(id);
    return next;
  });

  const choose = (node: ProfileTreeNode) => {
    if (node.kind === 'folder') toggle(node.id);
    else if (node.kind === 'subagent') {
      toggle(node.id, true);
      onSelect(node.id, coverPlace(node.id));
    } else onSelect(node.id, node.path);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-tree-row]')];
    const index = items.findIndex(item => item === document.activeElement);
    const id = items[index]?.dataset.treeRow;
    const row = rows.find(item => item.node.id === id);
    const focus = (target: HTMLElement | undefined) => { if (target) { event.preventDefault(); target.focus(); target.scrollIntoView({ block: 'nearest' }); } };
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      if (row?.node.kind === 'subagent' && tabCommand(row.node)) {
        event.preventDefault();
        onOpenTab(row.node);
      }
    } else if (event.key === 'ArrowDown') focus(items[Math.min(index + 1, items.length - 1)]);
    else if (event.key === 'ArrowUp') focus(items[Math.max(index - 1, 0)]);
    else if (event.key === 'ArrowRight' && row && isExpandable(row.node)) {
      event.preventDefault();
      if (!open.has(row.node.id)) toggle(row.node.id, true);
      else focus(items[index + 1]);
    } else if (event.key === 'ArrowLeft' && row) {
      event.preventDefault();
      if (isExpandable(row.node) && open.has(row.node.id)) toggle(row.node.id, false);
      else if (row.parent) focus(items.find(item => item.dataset.treeRow === row.parent));
    }
  };

  const coverSelected = coverId === '';
  return (
    // Round 5, layout (a): a right sidebar beside the file, headed Files.
    <div className="flex w-[260px] shrink-0 flex-col overflow-y-auto border-l border-border-primary bg-surface-secondary pb-2" data-testid="profiles-tree">
      <div className="flex h-[34px] shrink-0 items-center justify-between px-4 pt-1" aria-hidden="true">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Files</span>
        <span className="text-[11.5px] text-text-tertiary">and subagents</span>
      </div>
      <div ref={treeRef} role="tree" aria-label={`${profile.ref} files`} onKeyDown={onKeyDown}>
        <button
          type="button"
          role="treeitem"
          aria-selected={coverSelected}
          data-tree-row="cover"
          data-focus-entry={coverSelected ? '' : undefined}
          data-testid="profiles-tree-cover"
          onClick={() => onSelect(null, coverPlace())}
          className={cn(ROW, 'pl-[10px]', coverSelected ? 'bg-surface-hover text-text-primary' : 'text-text-primary hover:bg-surface-hover')}
        >
          <LayoutTemplate className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
          <span className="truncate">Cover page</span>
        </button>
        {rows.map(({ node, depth }) => {
          const isOn = selected(node);
          const pad = 10 + depth * 16;
          const expandable = isExpandable(node);
          const isOpen = expandable && open.has(node.id);
          const dirty = node.kind === 'file' && drafts[fileKey(plugin, node.path)] !== undefined;
          const state = node.kind === 'subagent' ? subagentState(node) : undefined;
          const tab = node.kind === 'subagent' && tabCommand(node) ? node : undefined;
          return (
            <button
              key={node.id}
              type="button"
              role="treeitem"
              aria-selected={isOn}
              aria-expanded={expandable ? isOpen : undefined}
              data-tree-row={node.id}
              data-focus-entry={isOn ? '' : undefined}
              data-testid={node.kind === 'file' ? `profiles-file-${node.path}` : `profiles-tree-${node.id}`}
              title={node.kind === 'file' ? node.path : node.kind === 'subagent' ? subagentTooltip(node) : undefined}
              onClick={() => choose(node)}
              aria-keyshortcuts={tab ? 'Meta+Enter Control+Enter' : undefined}
              className={cn(ROW, 'group', isOn ? 'bg-surface-hover text-text-primary' : 'text-text-primary hover:bg-surface-hover')}
              style={{ paddingLeft: pad }}
            >
              {expandable ? (
                <span
                  role="presentation"
                  className="-ml-1 flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary"
                  onClick={event => { event.stopPropagation(); toggle(node.id); }}
                >
                  <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')} aria-hidden="true" />
                </span>
              ) : <span className="-ml-1 w-4 shrink-0" aria-hidden="true" />}
              {node.kind === 'folder' && <Folder className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />}
              {node.kind === 'subagent' && <SubagentMark node={node} />}
              {node.kind === 'file' && <FileText className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />}
              <span className={cn('truncate', node.kind !== 'file' && 'font-medium', state === 'error' && 'text-status-warning', (state === 'cycle' || state === 'any') && 'font-normal text-text-secondary')}>
                {node.kind === 'subagent' ? subagentLabel(node) : node.label}
              </span>
              {node.kind === 'file' && node.note && <span className="shrink-0 text-[11.5px] text-text-secondary">{node.note}</span>}
              {node.kind === 'subagent' && (
                <span className={cn('min-w-0 shrink-[4] truncate text-[11.5px]', state === 'error' ? 'text-status-warning' : 'text-text-secondary')} data-testid={`profiles-tree-note-${node.id}`}>
                  {state === 'cycle' ? 'already above' : state === 'error' ? 'not found' : LINK_MODE_SHORT[node.mode]}
                </span>
              )}
              {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-warning" title="Unsaved changes" aria-label="unsaved" data-testid="profiles-file-dirty" />}
              {tab && (
                // Inside the row, as the chevron is, so the tree holds only rows; ⌘↩ (Ctrl+Enter) on the row does the same.
                <span
                  role="presentation"
                  title={`${tabActionLabel(tab, pane)} (${TAB_KEY})`}
                  data-testid={`profiles-tree-tab-${node.id}`}
                  onClick={event => { event.stopPropagation(); onOpenTab(tab); }}
                  className={cn(
                    '-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-tertiary hover:text-text-primary group-hover:opacity-100 group-focus-visible:opacity-100',
                    isOn ? 'opacity-100' : 'opacity-0',
                  )}
                >
                  <SquareTerminal className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
