import { Archive } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { useArchiveConfirmStore } from './archiveConfirm';

/** The one confirm for archiving a Pane, or a Session on another machine. */
export function ArchiveConfirmDialog() {
  const request = useArchiveConfirmStore(state => state.request);
  if (!request) return null;

  const close = () => {
    useArchiveConfirmStore.setState(state => state.request === request ? { request: null } : state);
    // The dialog hands focus back to its opener; a menu item that opened it is gone by now.
    requestAnimationFrame(() => {
      const target = request.returnFocus;
      if (target?.isConnected && (document.activeElement === document.body || document.activeElement === null)) target.focus();
    });
  };

  return (
    <ConfirmDialog
      isOpen
      onClose={close}
      onConfirm={() => void request.archive()}
      title={`Archive ${request.name}?`}
      message={request.message}
      confirmText="Archive"
      variant="warning"
      icon={<Archive className="h-6 w-6 flex-shrink-0 text-status-warning" />}
    />
  );
}
