import { API } from '../utils/api';
import { Modal, ModalBody, ModalHeader, ModalFooter } from './ui/Modal';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { useSessionStore } from '../stores/sessionStore';
import { useState } from 'react';
import { PromotePaneDialog } from './PromotePaneDialog';
import { Archive, Pin, ArrowUpRight, Pencil } from 'lucide-react';
import type { Session } from '../types/session';
import { PopoverButton, TerminalPopover } from './terminal/TerminalPopover';

export interface CompactSessionMenuState {
  session: Session;
  x: number;
  y: number;
}

interface CompactSessionMenuProps {
  menu: CompactSessionMenuState | null;
  onClose: () => void;
  onTogglePinned: () => void;
  onArchive: () => void;
}

/** Right-click actions for a pane in the collapsed sidebar rail. */
export function CompactSessionMenu({ menu, onClose, onTogglePinned, onArchive }: CompactSessionMenuProps) {
  const [promoting, setPromoting] = useState<Session | null>(null);
  const [renaming, setRenaming] = useState<Session | null>(null);
  return (<>
    <TerminalPopover
      visible={menu !== null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      onClose={onClose}
    >
      <div role="menu" aria-label={`Pane actions for ${menu?.session.name || 'Untitled'}`}>
        <PopoverButton role="menuitem" onClick={onTogglePinned}>
          <span className="flex items-center gap-2">
            <Pin className="h-4 w-4 rotate-45" />
            {menu?.session.isFavorite ? 'Unpin' : 'Pin'}
          </span>
        </PopoverButton>
        <PopoverButton role="menuitem" onClick={() => { if (menu) setPromoting(menu.session); onClose(); }}>
          <span className="flex items-center gap-2"><ArrowUpRight className="h-4 w-4" />Move chat to Session…</span>
        </PopoverButton>
        <PopoverButton role="menuitem" onClick={() => { if (menu) setRenaming(menu.session); onClose(); }}>
          <span className="flex items-center gap-2"><Pencil className="h-4 w-4" />Rename worktree…</span>
        </PopoverButton>
        {/* Archive sits last, past the divider: the menu opens under the cursor,
            so the top slot is the one clicked by reflex. */}
        <div className="my-1 border-t border-border-primary" />
        <PopoverButton role="menuitem" variant="danger" onClick={onArchive}>
          <span className="flex items-center gap-2">
            <Archive className="h-4 w-4" />
            Archive
          </span>
        </PopoverButton>
      </div>
    </TerminalPopover>
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
