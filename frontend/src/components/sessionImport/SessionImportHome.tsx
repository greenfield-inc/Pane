import { useEffect, useState } from 'react';
import { API } from '../../utils/api';
import { cn } from '../../utils/cn';
import { SessionImportCard } from './SessionImportCard';
import { SESSION_IMPORT_HOME_RETIRED_PREFERENCE, type SessionImportScan } from '../../../../shared/types/sessionImport';

/** Pane Chat's one-time "bring your sessions in" offer; the card replaces it. */
const PANE_CHAT_MIGRATE_OFFER_PREFERENCE = 'pane_chat_migrate_offer_sent';
const COLLAPSE_MS = 300;

/**
 * The card on Home for people just starting: shown while they have fewer than
 * two Panes, the scan found recent sessions, and they haven't closed it.
 * Home never waits for the scan; the card grows in when it arrives.
 */
export function SessionImportHome() {
  const [scan, setScan] = useState<SessionImportScan | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void API.sessionImport.home().then(found => {
      if (cancelled || !found) return;
      setScan(found);
      void API.preferences.set(PANE_CHAT_MIGRATE_OFFER_PREFERENCE, 'true');
      requestAnimationFrame(() => setOpen(true));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  if (!scan) return null;

  const close = () => {
    setOpen(false);
    // Unmount once the collapse has played; transitionend doesn't fire when motion is reduced or paused.
    window.setTimeout(() => setScan(null), COLLAPSE_MS);
    void API.preferences.set(SESSION_IMPORT_HOME_RETIRED_PREFERENCE, 'true');
  };

  return (
    <div
      className={cn('grid transition-[grid-template-rows,opacity] duration-300 ease-out', open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="mx-auto max-w-xl">
          <SessionImportCard surface="home" scan={scan} onClose={close} onRescanned={setScan} />
        </div>
      </div>
    </div>
  );
}
