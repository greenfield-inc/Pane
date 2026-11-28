import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronRight, FileText, Folder, LayoutTemplate } from 'lucide-react';
import type { ProfileSummary, ProfileTreeNode } from '../../../../shared/types/profileEditor';
import { coverPlace, fileKey, isCoverPlace, useProfilesStore } from '../../stores/profilesStore';
import { cn } from '../../utils/cn';
import { ProfileAvatar } from './ProfileAvatar';
import { ancestorsOf, visibleRows } from './profilePreview';

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
export function ProfileTree({ plugin, profile, file, selectedId, onSelect }: {
  plugin: string;
  profile: ProfileSummary;
  /** What the page shows: a file path, or a cover place. */
  file: string;
  /** The row last chosen, to tell apart a file that appears under two subagents. */
  selectedId: string | null;
  onSelect: (id: string | null, file: string) => void;
}) {
  const drafts = useProfilesStore(state => state.drafts);
  const [open, setOpen] = useState<Set<string>>(() => initiallyOpen(profile.tree));
  const treeRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => visibleRows(profile.tree, open), [open, profile.tree]);
  const coverId = isCoverPlace(file) ? file.slice('cover:'.length) : null;
  const selected = (node: ProfileTreeNode): boolean => {
    if (node.kind === 'subagent') return coverId === node.id;
    if (node.kind !== 'file' || node.path !== file) return false;
    return selectedId === null || selectedId === node.id || !rows.some(row => row.node.id === selectedId);
  };

  // The row on show stays visible: its folders open (a file opened from a cover's chip, or after New).
  useEffect(() => {
    const id = coverId || (selectedId ?? undefined) || firstWithPath(profile.tree, file)?.id;
    const trail = id ? ancestorsOf(profile.tree, id) : undefined;
    if (trail?.length && trail.some(item => !open.has(item))) setOpen(current => new Set([...current, ...trail]));
  }, [coverId, file, open, profile.tree, selectedId]);

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
    if (event.key === 'ArrowDown') focus(items[Math.min(index + 1, items.length - 1)]);
    else if (event.key === 'ArrowUp') focus(items[Math.max(index - 1, 0)]);
    else if (event.key === 'ArrowRight' && row && row.node.kind !== 'file') {
      event.preventDefault();
      if (!open.has(row.node.id)) toggle(row.node.id, true);
      else focus(items[index + 1]);
    } else if (event.key === 'ArrowLeft' && row) {
      event.preventDefault();
      if (row.node.kind !== 'file' && open.has(row.node.id)) toggle(row.node.id, false);
      else if (row.parent) focus(items.find(item => item.dataset.treeRow === row.parent));
    }
  };

  const coverSelected = coverId === '';
  return (
    <div className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-r border-border-primary py-2" data-testid="profiles-tree">
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
          const expandable = node.kind !== 'file';
          const isOpen = expandable && open.has(node.id);
          const dirty = node.kind === 'file' && drafts[fileKey(plugin, node.path)] !== undefined;
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
              title={node.kind === 'file' ? node.path : undefined}
              onClick={() => choose(node)}
              className={cn(ROW, isOn ? 'bg-surface-hover text-text-primary' : 'text-text-primary hover:bg-surface-hover')}
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
              {node.kind === 'subagent' && <ProfileAvatar profileRef={node.profile} agent={node.harness} size={16} />}
              {node.kind === 'file' && <FileText className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />}
              <span className={cn('truncate', node.kind !== 'file' && 'font-medium')}>{node.label}</span>
              {node.kind === 'file' && node.note && <span className="shrink-0 text-[11.5px] text-text-secondary">{node.note}</span>}
              {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-warning" title="Unsaved changes" aria-label="unsaved" data-testid="profiles-file-dirty" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
