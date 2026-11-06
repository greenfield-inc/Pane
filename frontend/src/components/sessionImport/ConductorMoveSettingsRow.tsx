import { useState } from 'react';
import { API } from '../../utils/api';
import { Button } from '../ui/Button';
import { Modal, ModalBody } from '../ui/Modal';
import { SettingRow } from '../settings/SettingRow';
import { ConductorMoveCard, CONDUCTOR_MOVE_TITLE } from './ConductorMoveCard';
import type { ConductorMoveScan } from '../../../../shared/types/conductorMove';
import type { MachineState } from '../../../../shared/types/machineConnections';

/** AI & Agents → "Move from Conductor": opens the move card in a dialog. */
export function ConductorMoveSettingsRow() {
  const [open, setOpen] = useState<{ scan: ConductorMoveScan; machines: MachineState[] } | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // While a move runs the dialog holds its result, so it can't be dismissed.
  const [busy, setBusy] = useState(false);

  const find = async () => {
    setFinding(true);
    setError(undefined);
    try {
      const [scan, machines] = await Promise.all([API.conductorMove.scan(), window.electronAPI.machines.list()]);
      setOpen({ scan, machines });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFinding(false);
    }
  };

  const close = () => setOpen(null);

  return (
    <>
      <SettingRow
        settingId="conductor-move"
        label={CONDUCTOR_MOVE_TITLE}
        description="Move every Conductor workspace on this Mac, with its uncommitted work and chats, to another machine such as a cloud machine."
        saveState={error ? { state: 'error', message: error } : undefined}
      >
        <Button variant="secondary" size="sm" onClick={() => void find()} loading={finding}>Find workspaces</Button>
      </SettingRow>
      <Modal
        isOpen={open !== null}
        onClose={() => { if (!busy) close(); }}
        size="md"
        ariaLabel={CONDUCTOR_MOVE_TITLE}
        showCloseButton={false}
        closeOnEscape={!busy}
        closeOnOverlayClick={!busy}
      >
        <ModalBody className="p-0">
          {open && (
            <ConductorMoveCard
              scan={open.scan}
              machines={open.machines}
              onClose={close}
              onRescanned={scan => setOpen(previous => previous && { ...previous, scan })}
              onBusyChange={setBusy}
            />
          )}
        </ModalBody>
      </Modal>
    </>
  );
}
