import { API } from '../utils/api';
import { Modal, ModalBody, ModalHeader, ModalFooter } from './ui/Modal';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { useSessionStore } from '../stores/sessionStore';
import { useRef, useState } from 'react';
import { RenamePaneDialog } from './RenamePaneDialog';
import { PromotePaneDialog } from './PromotePaneDialog';
import { Archive, Pin, ArrowUpRight, Pencil } from 'lucide-react';
import type { Session } from '../types/session';
import { PopoverButton, TerminalPopover } from './terminal/TerminalPopover';

export interface PaneContextMenuState {
  session: Session;
  label?: string;
  opener?: HTMLElement;
  x: number;
  y: number;
}

interface PaneContextMenuProps {
  menu: PaneContextMenuState | null;
  onClose: () => void;
  onRename?: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
}

/** Right-click actions for a pane in the collapsed sidebar rail. */
export function PaneContextMenu({ menu, onClose, onRename, onTogglePinned, onArchive }: PaneContextMenuProps) {
  const displayRenameOpener = useRef<HTMLElement | undefined>(undefined);
  const [displayRenaming, setDisplayRenaming] = useState<Session | null>(null);
  const [promoting, setPromoting] = useState<Session | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (items.length === 0) return;
    const activeIndex = Math.max(0, items.findIndex(item => item === document.activeElement));

    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = (activeIndex + 1) % items.length;
    if (event.key === 'ArrowUp') nextIndex = (activeIndex - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex !== undefined) {
      event.preventDefault();
      setFocusedIndex(nextIndex);
      items[nextIndex]?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      items[activeIndex]?.click();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const opener = menu?.opener;
      onClose();
      requestAnimationFrame(() => opener?.focus());
      return;
    }
    if (event.key === 'Tab') onClose();
  };

  return (<>
    <TerminalPopover
      visible={menu !== null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      onClose={onClose}
    >
      <div
        ref={menuRef}
        role="menu"
        aria-label={`Pane actions for ${menu?.session.name || 'Untitled'}`}
        onKeyDown={handleKeyDown}
      >
        <PopoverButton autoFocus role="menuitem" tabIndex={focusedIndex === 0 ? 0 : -1} onFocus={() => setFocusedIndex(0)} onClick={() => { if (onRename) onRename(); else if (menu) { displayRenameOpener.current = menu.opener; setDisplayRenaming(menu.session); onClose(); } }}>
          <span className="flex items-center gap-2"><Pencil className="h-4 w-4" />Rename</span>
        </PopoverButton>
        <PopoverButton role="menuitem" tabIndex={focusedIndex === 1 ? 0 : -1} onFocus={() => setFocusedIndex(1)} onClick={onTogglePinned}>
          <span className="flex items-center gap-2">
            <Pin className="h-4 w-4 rotate-45" />
            {menu?.session.isFavorite ? 'Unpin' : 'Pin'}
          </span>
        </PopoverButton>
        <PopoverButton role="menuitem" tabIndex={focusedIndex === 2 ? 0 : -1} onFocus={() => setFocusedIndex(2)} onClick={() => { if (menu) setPromoting(menu.session); onClose(); }}>
          <span className="flex items-center gap-2"><ArrowUpRight className="h-4 w-4" />Move chat to Session…</span>
        </PopoverButton>
        <PopoverButton role="menuitem" tabIndex={focusedIndex === 3 ? 0 : -1} onFocus={() => setFocusedIndex(3)} onClick={() => { if (menu) setRenaming(menu.session); onClose(); }}>
          <span className="flex items-center gap-2"><Pencil className="h-4 w-4" />Rename worktree…</span>
        </PopoverButton>
        {/* Archive sits last, past the divider: the menu opens under the cursor,
            so the top slot is the one clicked by reflex. */}
        <div className="my-1 border-t border-border-primary" />
        <PopoverButton role="menuitem" tabIndex={focusedIndex === 4 ? 0 : -1} onFocus={() => setFocusedIndex(4)} variant="danger" onClick={onArchive}>
          <span className="flex items-center gap-2"><Archive className="h-4 w-4" />Archive</span>
        </PopoverButton>
      </div>
    </TerminalPopover>
    <RenamePaneDialog session={displayRenaming} onClose={() => { setDisplayRenaming(null); requestAnimationFrame(() => displayRenameOpener.current?.focus()); }} />
    {renaming && <RenameWorktreeDialog key={renaming.id} session={renaming} onClose={() => setRenaming(null)} />}
    {promoting && <PromotePaneDialog key={promoting.id} paneId={promoting.id} paneName={promoting.name} onClose={() => setPromoting(null)} />}
  </>);
}


function RenameWorktreeDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const [name, setName] = useState(session.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (busy || !name.trim()) return;
    setBusy(true); setError(null);
    try {
      const result = await API.sessions.rename(session.id, name.trim());
      if (!result.success) throw new Error(result.error || 'Could not rename worktree');
      const current = useSessionStore.getState().sessions.find(item => item.id === session.id) ?? session;
      useSessionStore.getState().updateSession({ ...current, name: name.trim() });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not rename worktree');
    } finally { setBusy(false); }
  }
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} ariaLabel="Rename worktree">
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <ModalHeader title="Rename worktree" />
      <ModalBody>
        <Input label="Worktree name" autoFocus value={name} disabled={busy} onChange={event => setName(event.target.value)} fullWidth />
        {error && <p role="alert" className="mt-2 text-sm text-status-error">{error}</p>}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save name'}</Button>
      </ModalFooter>
    </form>
  </Modal>;
}
