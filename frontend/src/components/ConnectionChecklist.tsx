import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Button } from './ui/Button';
import { API } from '../utils/api';
import { cn } from '../utils/cn';
import type {
  RemoteConnectionCheck,
  RemoteConnectionCheckRow,
  RemoteConnectionCheckRowStatus,
} from '../../../shared/types/remoteDaemon';
import type { SettingsTarget } from '../types/settings';

const COPIED_MS = 1500;

/** Every status shares this 16px box, so a row never shifts as it changes. */
function StatusBadge({ status }: { status: RemoteConnectionCheckRowStatus }) {
  const box = 'flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] text-[10px] font-bold leading-none';
  switch (status) {
    case 'passed':
      return <span className={cn(box, 'border-status-success bg-status-success text-text-on-status-success')}><Check aria-hidden="true" className="h-2.5 w-2.5" strokeWidth={3} /></span>;
    case 'failed':
      return <span className={cn(box, 'border-status-error text-status-error')} aria-hidden="true">!</span>;
    case 'warning':
      return <span className={cn(box, 'border-status-warning text-status-warning')} aria-hidden="true">!</span>;
    case 'running':
      return <span className={cn(box, 'animate-spin border-interactive border-r-transparent')} aria-hidden="true" />;
    case 'waiting':
      return <span className={cn(box, 'border-border-primary')} aria-hidden="true" />;
  }
}

interface ChecklistRowProps {
  status: RemoteConnectionCheckRowStatus;
  label: string;
  metric?: string;
  detail?: string;
  action?: ReactNode;
}

/** One step of a checklist: a status badge, the step's text, and a metric or a fix on the right. */
export function ChecklistRow({ status, label, metric, detail, action }: ChecklistRowProps) {
  const problem = status === 'failed' || status === 'warning';
  const right = action ?? (status === 'waiting' ? 'waiting' : metric);
  return (
    <li
      data-status={status}
      className={cn(
        'flex items-center gap-2.5 rounded-lg border border-border-secondary bg-surface-secondary px-2.5 py-[7px] text-[13px] text-text-primary',
        status === 'waiting' && 'opacity-60',
      )}
    >
      <StatusBadge status={status} />
      <div className="min-w-0 flex-1">
        <p className={cn(problem && 'font-semibold')}>{label}</p>
        {detail && <p className="mt-0.5 text-xs text-text-secondary">{detail}</p>}
      </div>
      {right && <div className="flex flex-none items-center gap-1.5 whitespace-nowrap text-[11px] text-text-tertiary">{right}</div>}
    </li>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function footnote(check: RemoteConnectionCheck): string | null {
  const time = check.lastConnectedAt ? formatTime(check.lastConnectedAt) : null;
  if (time && check.hostVersion) return `Last connected at ${time}, running Pane ${check.hostVersion}.`;
  if (time) return `Last connected at ${time}.`;
  if (check.hostVersion) return `${check.hostLabel} runs Pane ${check.hostVersion}.`;
  return null;
}

interface ConnectionChecklistProps {
  check: RemoteConnectionCheck;
  onOpenSettings: (target: SettingsTarget) => void;
  onUpdatePane: () => void;
}

/** The main area while a connect the user started runs, fails or warns: each stage and the fix for the failing one. */
export function ConnectionChecklist({ check, onOpenSettings, onUpdatePane }: ConnectionChecklistProps) {
  const [copiedStage, setCopiedStage] = useState<string | null>(null);
  const note = footnote(check);

  const runFix = (row: RemoteConnectionCheckRow) => {
    const fix = row.fix;
    if (!fix) return;
    switch (fix.kind) {
      case 'run-on-host':
        void API.remoteDaemon.runCheckFix(check.id, row.stage);
        return;
      case 'copy-command':
        if (!fix.command) return;
        void navigator.clipboard.writeText(fix.command).then(() => {
          setCopiedStage(row.stage);
          setTimeout(() => setCopiedStage(null), COPIED_MS);
        });
        return;
      case 'download-tailscale':
        void window.electronAPI.openExternal('https://tailscale.com/download');
        return;
      case 'open-tailscale':
      case 'enter-password':
        onOpenSettings({ category: 'remote-access', setting: 'remote-machines' });
        return;
      case 'paste-code':
        onOpenSettings({ category: 'remote-access', setting: 'remote-add-code' });
        return;
      case 'update-pane':
        onUpdatePane();
        return;
    }
  };

  const connect = (mode: 'remote' | 'local') => {
    void API.remoteDaemon.updateClientState(mode === 'remote' ? { mode, activeProfileId: check.profileId } : { mode });
  };

  const rowAction = (row: RemoteConnectionCheckRow) => {
    const continueButton = check.outcome === 'warning' && row.status === 'warning' && (
      <Button size="sm" onClick={() => void API.remoteDaemon.dismissCheck(check.id)}>Continue to workspace</Button>
    );
    const fixButton = row.fix && (row.status === 'failed' || row.status === 'warning') && (
      <Button size="sm" variant={continueButton ? 'secondary' : 'primary'} onClick={() => runFix(row)}>
        {copiedStage === row.stage ? 'Copied' : row.fix.label}
      </Button>
    );
    if (!fixButton && !continueButton) return undefined;
    return <>{fixButton}{continueButton}</>;
  };

  const quietLink = 'text-text-secondary hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:underline';
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-bg-primary p-6">
      <section aria-label={`Connecting to ${check.hostLabel}`} className="w-[430px] max-w-full rounded-[14px] border border-border-secondary bg-surface-primary px-4 py-3.5 shadow-sm">
        <h2 className="text-sm font-semibold text-text-primary">Connecting to {check.hostLabel}</h2>
        <p className="mb-2.5 mt-1 text-xs text-text-tertiary">over {check.route} · {check.address}</p>
        <ul className="space-y-1.5" aria-live="polite">
          {check.rows.map((row) => (
            <ChecklistRow key={row.stage} status={row.status} label={row.label} metric={row.metric} detail={row.detail} action={rowAction(row)} />
          ))}
        </ul>
        {note && <p className="mt-2.5 text-xs text-text-tertiary">{note}</p>}
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary">
          <button type="button" className={quietLink} onClick={() => connect('remote')}>Retry</button>
          <span aria-hidden="true">·</span>
          <button type="button" className={quietLink} onClick={() => connect('local')}>Use this computer</button>
          <span aria-hidden="true">·</span>
          <button type="button" className={quietLink} onClick={() => onOpenSettings({ category: 'remote-access' })}>Connection settings</button>
        </p>
      </section>
    </div>
  );
}
