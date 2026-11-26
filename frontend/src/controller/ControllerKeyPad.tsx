/**
 * X on a controller in a terminal: a small pad of the keys a pad lacks (Esc,
 * ^C, Tab, Shift+Tab), picked with the D-pad and A, sent to the agent.
 */
import { useRef } from 'react';
import { Modal, ModalBody, ModalHeader } from '../components/ui/Modal';
import { focusedControllerTarget, type ControllerTarget, type TerminalKey } from './controllerTargets';
import { useControllerStore } from './controllerStore';

const KEYS: ReadonlyArray<{ key: TerminalKey; label: string }> = [
  { key: 'escape', label: 'Esc' },
  { key: 'ctrl-c', label: '^C' },
  { key: 'tab', label: 'Tab' },
  { key: 'shift-tab', label: 'Shift+Tab' },
];

export function ControllerKeyPad() {
  // The terminal the pad was opened from; focus moves into the pad while it is open.
  const target = useRef<ControllerTarget | null>(focusedControllerTarget());
  const firstKey = useRef<HTMLButtonElement>(null);
  const close = () => useControllerStore.setState({ keyPadOpen: false });
  return (
    <Modal isOpen onClose={close} size="sm" instant showCloseButton={false} ariaLabel="Key pad" initialFocusRef={firstKey}>
      <ModalHeader title="Keys" onClose={close} />
      <ModalBody>
        <div className="grid grid-cols-4 gap-2" data-testid="controller-key-pad">
          {KEYS.map(({ key, label }, index) => (
            <button
              key={key}
              ref={index === 0 ? firstKey : undefined}
              type="button"
              className="h-10 rounded border border-border-primary bg-surface-secondary text-sm text-text-primary hover:bg-surface-hover"
              onClick={() => target.current?.pressKey?.(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </ModalBody>
    </Modal>
  );
}
