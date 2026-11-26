/**
 * The controller cheat sheet: every button in the pad's own labels (✕○□△ on
 * a PlayStation pad), or a note when Pane can't read the pad's layout. It
 * shows on the first press after install, while − is held, and from
 * Settings › Controller.
 */
import { useRef } from 'react';
import { cheatSheet } from '../../../shared/controller/bindings';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../components/ui/Modal';
import { requestOpenSettings } from '../utils/openSettings';
import { useControllerStore } from './controllerStore';

export const CONTROLLER_DOCS_URL = 'https://github.com/greenfield-inc/Pane/blob/main/docs/CONTROLLERS.md';

export function ControllerCheatSheet({ opener }: { opener: HTMLElement | null }) {
  const state = useControllerStore(store => store.cheatSheet);
  const family = useControllerStore(store => store.family);
  const deviceName = useControllerStore(store => store.device?.name);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheet = cheatSheet(family);
  const close = () => {
    useControllerStore.setState({ cheatSheet: 'closed' });
    opener?.focus({ preventScroll: true });
  };
  return (
    <Modal isOpen={state !== 'closed'} onClose={close} size="md" instant showCloseButton={false} ariaLabel="Controller buttons" initialFocusRef={closeRef} restoreFocusOnClose={false}>
      <ModalHeader title="Controller buttons" onClose={close} />
      <ModalBody>
        {deviceName && <p className="mb-3 text-xs text-text-tertiary" data-testid="controller-cheat-sheet-device">{deviceName}</p>}
        {sheet.note
          ? <p className="text-sm text-text-primary" data-testid="controller-cheat-sheet-note">{sheet.note}</p>
          : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm" data-testid="controller-cheat-sheet">
              {sheet.rows.map(row => (
                <div key={row.label} className="contents">
                  <dt className="flex gap-1">
                    {row.keys.map(key => (
                      <kbd key={key} className="inline-flex h-6 min-w-6 items-center justify-center rounded border border-border-primary bg-surface-secondary px-1.5 text-xs text-text-primary">{key}</kbd>
                    ))}
                  </dt>
                  <dd className="text-text-secondary">{row.label}</dd>
                </div>
              ))}
            </dl>
          )}
      </ModalBody>
      <ModalFooter>
        <a className="mr-auto text-xs text-text-tertiary underline" href={CONTROLLER_DOCS_URL} target="_blank" rel="noreferrer">Controller guide</a>
        <button type="button" className="text-xs text-text-secondary underline" onClick={() => { close(); requestOpenSettings({ category: 'shortcuts', setting: 'controller' }); }}>Button letters…</button>
        <button ref={closeRef} type="button" className="rounded border border-border-primary px-3 py-1 text-sm text-text-primary" onClick={close}>Close</button>
      </ModalFooter>
    </Modal>
  );
}
