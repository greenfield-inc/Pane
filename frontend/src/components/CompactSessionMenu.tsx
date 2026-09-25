import { useState } from 'react';
import { PromotePaneDialog } from './PromotePaneDialog';
import { Archive, Pin, ArrowUpRight } from 'lucide-react';
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
    {promoting && <PromotePaneDialog key={promoting.id} paneId={promoting.id} paneName={promoting.name} onClose={() => setPromoting(null)} />}
  </>);
}
