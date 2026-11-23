import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Cloud } from 'lucide-react';
import { Button } from '../ui/Button';
import { RemoteGroup } from './RemoteGroup';
import { DetailsFrame } from './MachineDetails';
import { CARD_ROW } from './CodelessRemoteSettings';
import { usePaneCloudStore } from '../../stores/paneCloudStore';
import { paneCloudMachine, PANE_CLOUD_MACHINE } from '../../../../shared/utils/paneCloudMachine';
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

/** One logged operation and the cloud Session it ran on. */
interface SessionAction extends PaneCloudAction {
  sessionName: string;
}

/**
 * The "Pane Cloud" machine's page (D-90): its Sessions, Update Pane on each awake one, and every
 * operation Pane Cloud ran on them with who asked and why (D-6). No machine states: those are Greenfield's.
 */
export function PaneCloudMachinePage({ onBack }: { onBack: () => void }) {
  const sessions = usePaneCloudStore((state) => state.snapshot.sessions);
  const busyIds = usePaneCloudStore((state) => state.snapshot.busy);
  // Update Pane fails the way any Pane Cloud call does, in the shared snapshot.
  const actionError = usePaneCloudStore((state) => state.snapshot.error);
  const [actions, setActions] = useState<SessionAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => usePaneCloudStore.getState().follow(), []);

  // Main pushes a new snapshot when anything changes, such as a Pane version after an update: each one reads the logs again.
  const members = useMemo(() => paneCloudMachine(sessions)?.members ?? [], [sessions]);
  const versionOf = new Map(sessions.map((session) => [session.vmId, session.paneVersion]));
  const awake = members.filter((member) => member.awake);
  const busy = members.some((member) => busyIds.includes(member.vmId));

  useEffect(() => {
    if (members.length === 0) return undefined;
    let cancelled = false;
    void Promise.all(members.map(async ({ vmId, sessionName }) => {
      const response = await window.electronAPI.paneCloud.actions(vmId);
      if (!response.success || !response.data) {
        throw new Error([response.error, response.details].filter(Boolean).join(' ') || `Pane Cloud did not send the action log for ${sessionName}.`);
      }
      return response.data.map((action) => ({ ...action, sessionName }));
    })).then((logs) => {
      if (cancelled) return;
      setError(null);
      setActions(logs.flat().sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt)));
    }, (cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [members, busy]);

  const updatePane = () => {
    const store = usePaneCloudStore.getState();
    for (const member of awake) void store.updatePane(member.vmId);
  };

  return (
    <DetailsFrame onBack={onBack}>
      <div className="flex items-center gap-4">
        <span className="flex h-11 w-11 flex-none items-center justify-center rounded-lg bg-surface-secondary">
          <Cloud className="h-5 w-5 text-text-secondary" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-xl font-semibold text-text-primary">{PANE_CLOUD_MACHINE.name}</h2>
          <p className="truncate text-sm text-text-tertiary">{members.length === 1 ? '1 Session' : `${members.length} Sessions`}</p>
        </div>
      </div>

      <RemoteGroup title="Sessions">
        {members.length === 0 && <p className={`text-sm text-text-tertiary ${CARD_ROW}`}>No cloud Session is paired with this computer.</p>}
        <ul aria-label="Sessions" className="divide-y divide-border-secondary">
          {members.map((member) => (
            <li key={member.vmId}>
              <Row label={member.sessionName} detail={`Pane ${versionOf.get(member.vmId) ?? 'installing'}`}>
                <span className="text-sm text-text-secondary">{member.awake ? 'Running' : 'Stopped'}</span>
              </Row>
            </li>
          ))}
        </ul>
      </RemoteGroup>

      <RemoteGroup title="Pane">
        <Row label="Pane" detail="Updates each running Session to a published release, checked against its checksum.">
          <Button type="button" variant="ghost" size="sm" disabled={awake.length === 0} loading={busy} onClick={updatePane}>Update Pane</Button>
        </Row>
        {actionError && <p className={`text-sm text-status-error ${CARD_ROW}`} role="alert">{[actionError.message, actionError.next].filter(Boolean).join(' ')}</p>}
      </RemoteGroup>

      <RemoteGroup title="Recent actions" footnote="Every operation you or Pane Cloud asked for on these cloud Sessions, newest first.">
        {error && <p className={`text-sm text-status-error ${CARD_ROW}`} role="alert">{error}</p>}
        {actions?.length === 0 && <p className={`text-sm text-text-tertiary ${CARD_ROW}`}>Nothing yet.</p>}
        <ul aria-label="Recent actions">
          {(actions ?? []).map((action) => (
            <li key={`${action.sessionName}:${action.id}`} className={`flex items-start justify-between gap-3 ${CARD_ROW}`}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">{OPERATION_LABELS[action.operation]} · {action.sessionName}</p>
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
    </DetailsFrame>
  );
}

function Row({ label, detail, children }: { label: string; detail?: string; children: ReactNode }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${CARD_ROW}`}>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-text-primary">{label}</p>
        {detail && <p className="text-xs text-text-tertiary">{detail}</p>}
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}
