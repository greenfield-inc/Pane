import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../ui/Button';
import { RemoteGroup } from './RemoteGroup';
import { CARD_ROW } from './CodelessRemoteSettings';
import { usePaneCloudStore } from '../../stores/paneCloudStore';
import type { PaneCloudAction, PaneCloudOperation } from '../../../../shared/types/paneCloud';

/** What each logged operation is called on the page. */
const OPERATION_LABELS = {
  create: 'Created',
  start: 'Started',
  stop: 'Stopped',
  delete: 'Deleted',
  bootstrap: 'Installed Pane',
  update_pane: 'Updated Pane',
  prepare_to_stop: 'Prepared to stop',
  collect_diagnostics: 'Collected diagnostics',
  create_pairing_link: 'Paired a device',
} satisfies Record<PaneCloudOperation, string>;

/**
 * The Pane Cloud part of a cloud Session's machine page: the Pane version with Update, and every
 * operation Pane Cloud ran on it with who asked and why (D-6). No machine states: those are Greenfield's.
 */
export function PaneCloudMachineGroups({ machineId }: { machineId: string }) {
  const cloud = usePaneCloudStore((state) => state.snapshot.sessions.find((session) => session.machineId === machineId) ?? null);
  const busy = usePaneCloudStore((state) => cloud !== null && state.snapshot.busy.includes(cloud.vmId));
  const [actions, setActions] = useState<PaneCloudAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Update Pane fails the way any Pane Cloud call does, in the shared snapshot.
  const actionError = usePaneCloudStore((state) => state.snapshot.error);
  useEffect(() => usePaneCloudStore.getState().follow(), []);
  const vmId = cloud?.vmId ?? null;
  const paneVersion = cloud?.paneVersion ?? null;
  useEffect(() => {
    if (!vmId) return undefined;
    let cancelled = false;
    window.electronAPI.paneCloud.actions(vmId).then((response) => {
      if (cancelled) return;
      if (response.success && response.data) setActions(response.data);
      else setError([response.error, response.details].filter(Boolean).join(' ') || 'Pane Cloud did not send the action log.');
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
    // A new Pane version means a new operation in the log.
  }, [vmId, paneVersion, busy]);
  if (!cloud) return null;

  return (
    <>
      <RemoteGroup title="Pane Cloud">
        <Row label="Pane" detail="Updates install a published release, checked against its checksum.">
          <span className="text-sm text-text-secondary">{cloud.paneVersion ?? 'Installing'}</span>
          <Button type="button" variant="ghost" size="sm" disabled={!cloud.awake} loading={busy} onClick={() => void usePaneCloudStore.getState().updatePane(cloud.vmId)}>Update Pane</Button>
        </Row>
        {actionError && <p className={`text-sm text-status-error ${CARD_ROW}`} role="alert">{[actionError.message, actionError.next].filter(Boolean).join(' ')}</p>}
      </RemoteGroup>
      <RemoteGroup title="Recent actions" footnote="Every operation you or Pane Cloud asked for on this cloud Session, newest first.">
        {error && <p className={`text-sm text-status-error ${CARD_ROW}`} role="alert">{error}</p>}
        {actions?.length === 0 && <p className={`text-sm text-text-tertiary ${CARD_ROW}`}>Nothing yet.</p>}
        <ul aria-label="Recent actions">
          {(actions ?? []).map((action) => (
            <li key={action.id} className={`flex items-start justify-between gap-3 ${CARD_ROW}`}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">{OPERATION_LABELS[action.operation]}</p>
                <p className="text-xs text-text-tertiary">{action.reason}{action.error ? ` · ${action.error}` : ''}</p>
              </div>
              <div className="flex-none text-right text-xs text-text-tertiary">
                <p>By {action.actor}</p>
                <p><time dateTime={action.requestedAt}>{new Date(action.requestedAt).toLocaleString()}</time>{action.failed ? ' · failed' : ''}</p>
              </div>
            </li>
          ))}
        </ul>
      </RemoteGroup>
    </>
  );
}

function Row({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${CARD_ROW}`}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-text-primary">{label}</p>
        {detail && <p className="text-xs text-text-tertiary">{detail}</p>}
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}
