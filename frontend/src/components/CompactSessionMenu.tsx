import { API } from '../utils/api';
import { Modal, ModalBody, ModalHeader, ModalFooter } from './ui/Modal';
import { Input } from './ui/Input';
import { Button } from './ui/Button';
import { useSessionStore } from '../stores/sessionStore';
import { useState } from 'react';
import { PromotePaneDialog } from './PromotePaneDialog';
import { Archive, Pin, ArrowUpRight, Pencil, FolderPlus, FolderMinus, ChevronLeft, ChevronRight } from 'lucide-react';
import { isArchivedOrchestrationSession, useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
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
  const [membershipError, setMembershipError] = useState<string | null>(null);
  const orchestrationSessions = useOrchestrationSessionStore(state => state.sessions);
  const refreshOrchestrationSessions = useOrchestrationSessionStore(state => state.refresh);
  const paneId = menu?.session.id;
  const activeSessions = orchestrationSessions.filter(session => !isArchivedOrchestrationSession(session));
  const memberOf = activeSessions.filter(session => session.associations.some(association => association.paneId === paneId));
  const addableTo = activeSessions.filter(session => !memberOf.includes(session));
  // "Add to Session" swaps the menu to a Session list in place, so the menu stays short however many Sessions exist.
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const picking = paneId !== undefined && pickingFor === paneId;

  function close() {
    setPickingFor(null);
    onClose();
  }

  async function changeMembership(sessionId: string, action: 'add' | 'remove') {
    if (!paneId) return;
    close();
    setMembershipError(null);
    const result = action === 'add'
      ? await API.orchestrationSessions.associate({ sessionId }, { paneId })
      : await API.orchestrationSessions.detach({ sessionId }, paneId);
    if (!result.success) setMembershipError(result.error || 'Could not update the Session');
    await refreshOrchestrationSessions();
  }

  return (<>
    <TerminalPopover
      visible={menu !== null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      onClose={close}
    >
      {picking ? (
        <div role="menu" aria-label={`Add ${menu?.session.name || 'Untitled'} to a Session`}>
          <PopoverButton role="menuitem" onClick={() => setPickingFor(null)}>
            <span className="flex items-center gap-2"><ChevronLeft className="h-4 w-4" />Back</span>
          </PopoverButton>
          <div className="my-1 border-t border-border-primary" />
          {addableTo.map(session => (
            <PopoverButton key={session.id} role="menuitem" onClick={() => void changeMembership(session.id, 'add')}>
              <span className="block max-w-64 truncate">{session.name}</span>
            </PopoverButton>
          ))}
        </div>
      ) : (
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
          <span className="flex items-center gap-2"><Pencil className="h-4 w-4" />Rename Pane…</span>
        </PopoverButton>
        {(addableTo.length > 0 || memberOf.length > 0) && <div className="my-1 border-t border-border-primary" />}
        {addableTo.length > 0 && (
          <PopoverButton role="menuitem" aria-haspopup="menu" onClick={() => { if (paneId) setPickingFor(paneId); }}>
            <span className="flex items-center gap-2"><FolderPlus className="h-4 w-4" />Add to Session<ChevronRight className="ml-auto h-4 w-4" /></span>
          </PopoverButton>
        )}
        {memberOf.map(session => (
          <PopoverButton key={`remove-${session.id}`} role="menuitem" onClick={() => void changeMembership(session.id, 'remove')}>
            <span className="flex min-w-0 items-center gap-2"><FolderMinus className="h-4 w-4 flex-shrink-0" /><span className="truncate">Remove from {session.name}</span></span>
          </PopoverButton>
        ))}
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
      )}
    </TerminalPopover>
    {membershipError && (
      <Modal isOpen onClose={() => setMembershipError(null)} ariaLabel="Session update failed">
        <ModalHeader title="Session update failed" />
        <ModalBody><p role="alert" className="text-sm text-status-error">{membershipError}</p></ModalBody>
        <ModalFooter><Button type="button" onClick={() => setMembershipError(null)}>OK</Button></ModalFooter>
      </Modal>
    )}
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
      if (!result.success) throw new Error(result.error || 'Could not rename Pane');
      const current = useSessionStore.getState().sessions.find(item => item.id === session.id) ?? session;
      useSessionStore.getState().updateSession({ ...current, name: name.trim() });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not rename Pane');
    } finally { setBusy(false); }
  }
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} ariaLabel="Rename Pane">
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <ModalHeader title="Rename Pane" />
      <ModalBody>
        <Input label="Pane name" autoFocus value={name} disabled={busy} onChange={event => setName(event.target.value)} fullWidth />
        {error && <p role="alert" className="mt-2 text-sm text-status-error">{error}</p>}
      </ModalBody>
      <ModalFooter>
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save name'}</Button>
      </ModalFooter>
    </form>
  </Modal>;
}
