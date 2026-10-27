import { useState } from 'react';
import { API } from '../../utils/api';
import { Button } from '../ui/Button';
import { Modal, ModalBody } from '../ui/Modal';
import { SettingRow } from '../settings/SettingRow';
import { SessionImportCard, SESSION_IMPORT_TITLE } from './SessionImportCard';
import { SESSION_IMPORT_HOME_RETIRED_PREFERENCE, type SessionImportScan } from '../../../../shared/types/sessionImport';

/** AI & Agents → "Bring sessions into Pane": always reachable, opens the card in a dialog. */
export function SessionImportSettingsRow() {
  const [scan, setScan] = useState<SessionImportScan | null>(null);
  const [finding, setFinding] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // While an import runs the dialog holds its result, so it can't be dismissed.
  const [busy, setBusy] = useState(false);

  const find = async () => {
    setFinding(true);
    setError(undefined);
    try {
      setScan(await API.sessionImport.scan());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFinding(false);
    }
  };

  const close = (finished: boolean) => {
    // A finished import retires the Home card too.
    if (finished) void API.preferences.set(SESSION_IMPORT_HOME_RETIRED_PREFERENCE, 'true');
    setScan(null);
  };

  return (
    <>
      <SettingRow
        settingId="session-import"
        label="Bring sessions into Pane"
        description="Open sessions from Claude Code, Codex, Conductor and other tools as Panes."
        saveState={error ? { state: 'error', message: error } : undefined}
      >
        <Button variant="secondary" size="sm" onClick={() => void find()} loading={finding}>Find sessions</Button>
      </SettingRow>
      <Modal
        isOpen={scan !== null}
        onClose={() => { if (!busy) close(false); }}
        size="md"
        ariaLabel={SESSION_IMPORT_TITLE}
        showCloseButton={false}
        closeOnEscape={!busy}
        closeOnOverlayClick={!busy}
      >
        <ModalBody className="p-0">
          {scan && <SessionImportCard surface="settings" scan={scan} onClose={close} onRescanned={setScan} onBusyChange={setBusy} />}
        </ModalBody>
      </Modal>
    </>
  );
}
