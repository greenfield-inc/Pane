import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Loader2 } from 'lucide-react';
import { filterBranches } from './branchFilter';
import { usePortalContainer } from '../../contexts/PortalContainerContext';

export interface BranchComboboxProps {
  value: string;
  branches: string[];
  /**
   * The short list shown first — the branches this clone knows. The rest stay
   * one click away; an upstream with 191 branches is not a menu.
   */
  primaryBranches?: string[];
  /** Named in the "show all" row, e.g. `dcouple/Pane`. */
  allLabel?: string;
  onChange: (branch: string) => void;
  loading?: boolean;
  placeholder?: string;
  id?: string;
  'aria-label'?: string;
}

/**
 * Pick a branch from a long list, or type one that is not in it yet.
 *
 * Deliberately not a `<datalist>`: the browser filters those against the text
 * already in the field, so a field holding "main" offers only `main*` and hides
 * every other branch — which looks like the list itself is broken. Here the
 * full list opens on click and typing *ranks* it instead of cutting it down.
 *
 * The menu is portalled into the dialog's own portal container: the dialog body
 * scrolls, so an absolutely positioned list would be clipped by it — but a
 * portal to `document.body` lands *behind* the modal and outside its pointer
 * scope, which looks exactly like a dropdown that refuses to open.
 */
export function BranchCombobox({
  value,
  branches,
  primaryBranches,
  allLabel,
  onChange,
  loading = false,
  placeholder = 'main',
  id,
  'aria-label': ariaLabel = 'Base branch',
}: BranchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; flip: boolean } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The modal's container sits inside its stacking and pointer scope; falling
  // back to the body keeps the component usable outside a modal.
  const portalContainer = usePortalContainer();

  // `query === null` means "untouched since opening", which shows the list as
  // it is; the moment the user types, ranking takes over.
  const shortList = primaryBranches?.length ? primaryBranches : branches;
  const visible = showAll ? branches : shortList;

  const matches = useMemo(
    () => filterBranches(visible, query ?? ''),
    [visible, query]
  );

  /**
   * How many further branches the target has that the short list hides. Shown
   * as a row rather than silently dropped — a hidden branch reads as a bug.
   */
  const hiddenCount = useMemo(() => {
    if (showAll || visible === branches) return 0;
    return Math.max(0, filterBranches(branches, query ?? '', Number.MAX_SAFE_INTEGER).length - matches.length);
  }, [showAll, visible, branches, query, matches.length]);

  const position = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const box = input.getBoundingClientRect();
    const spaceBelow = window.innerHeight - box.bottom;
    setRect({
      top: spaceBelow < 220 ? box.top : box.bottom,
      left: box.left,
      width: box.width,
      flip: spaceBelow < 220,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    position();

    const onScrollOrResize = () => position();
    window.addEventListener('resize', onScrollOrResize);
    // Capture phase: the dialog body is the element that actually scrolls.
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      // SAFETY: DOM mouse events always expose a Node target while dispatched from document.
      const target = event.target as Node;
      if (inputRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
      setQuery(null);
      setShowAll(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const commit = useCallback((branch: string) => {
    onChange(branch);
    setQuery(null);
    setOpen(false);
    setShowAll(false);
    inputRef.current?.focus();
  }, [onChange]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(current => {
        if (matches.length === 0) return 0;
        return (current + step + matches.length) % matches.length;
      });
      return;
    }

    if (event.key === 'Enter' && open && matches[activeIndex]) {
      event.preventDefault();
      commit(matches[activeIndex]);
      return;
    }

    if (event.key === 'Escape' && open) {
      // Swallowed on purpose: closing the menu must not also close the dialog.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery(null);
    }
  };

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  // pointer-events-auto on the menu itself: the modal's container is
  // click-through so it does not swallow clicks meant for the dialog.
  const menu = open && rect && createPortal(
    <div
      ref={menuRef}
      role="listbox"
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        top: rect.flip ? undefined : rect.top,
        bottom: rect.flip ? window.innerHeight - rect.top : undefined,
        left: rect.left,
        width: rect.width,
      }}
      className="pointer-events-auto z-[1000] max-h-56 overflow-y-auto rounded border border-border-primary bg-surface-primary py-1 shadow-lg"
    >
      {matches.length === 0 && hiddenCount === 0 ? (
        <div className="px-2 py-1.5 text-xs text-text-muted">
          {branches.length === 0 ? 'No branches loaded' : 'No branch matches'}
        </div>
      ) : (
        matches.map((branch, index) => (
          <button
            key={branch}
            type="button"
            role="option"
            data-index={index}
            aria-selected={branch === value}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => commit(branch)}
            className={`block w-full truncate px-2 py-1 text-left text-xs ${
              index === activeIndex ? 'bg-surface-hover text-text-primary' : 'text-text-secondary'
            } ${branch === value ? 'font-semibold' : ''}`}
          >
            {branch}
          </button>
        ))
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => { setShowAll(true); setActiveIndex(0); }}
          className="mt-1 block w-full border-t border-border-secondary px-2 py-1.5 text-left text-[11px] text-text-muted transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          Show {hiddenCount} more{allLabel ? ` in ${allLabel}` : ''}
        </button>
      )}
    </div>,
    portalContainer ?? document.body
  );

  return (
    <div className="relative">
      <input
        id={id}
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? `${id ?? 'branch'}-listbox` : undefined}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        value={query ?? value}
        placeholder={placeholder}
        onChange={event => {
          setQuery(event.target.value);
          onChange(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={() => { setOpen(true); setActiveIndex(0); }}
        onClick={() => { setOpen(true); }}
        onKeyDown={handleKeyDown}
        className="w-full rounded border border-border-secondary bg-surface-primary px-2 py-1 pr-7 text-sm text-text-primary focus:border-interactive focus:outline-none"
      />
      <span className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center text-text-muted">
        {loading
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
      </span>
      {menu}
    </div>
  );
}
