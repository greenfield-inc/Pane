import { useCallback, useRef, useState, type MouseEvent } from 'react';
import type { PaneContextMenuState } from '../components/PaneContextMenu';
import type { Session } from '../types/session';

export function usePaneContextMenu() {
  const [menu, setMenu] = useState<PaneContextMenuState | null>(null);
  const [renameTarget, setRenameTarget] = useState<Session | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const openMenu = useCallback((
    event: MouseEvent<HTMLElement>,
    session: Session,
    opener: HTMLElement = event.currentTarget,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    openerRef.current = opener;
    setMenu({ session, opener, x: event.clientX, y: event.clientY });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const startRename = useCallback(() => {
    setRenameTarget(menu?.session ?? null);
    setMenu(null);
  }, [menu]);

  const finishRename = useCallback(() => {
    setRenameTarget(null);
    requestAnimationFrame(() => openerRef.current?.focus());
  }, []);

  return { menu, openMenu, closeMenu, renameTarget, startRename, finishRename };
}
