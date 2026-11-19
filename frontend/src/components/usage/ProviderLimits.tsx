import type { UsageProvider, UsageRateLimitSample } from '../../../../shared/types/usage';
import type { MachineState } from '../../../../shared/types/machineConnections';
import type { AccountUsage } from './allMachinesUsage';
import type { MachineUsageState } from './useMachinesUsage';
import { formatTokens } from '../ui/charts/chartScales';

const PROVIDER_META = {
  claude: { label: 'Anthropic', noLimits: 'Claude Code does not record plan limits locally.' },
  codex: { label: 'OpenAI', noLimits: 'No limits reported yet. Codex records them as it runs.' },
} satisfies Record<UsageProvider, { label: string; noLimits: string }>;

function formatWindow(minutes: number): string {
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d window`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

function formatAge(atMs: number): string {
  const elapsed = Date.now() - atMs;
  if (elapsed < 60_000) return 'just now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatReset(atMs: number): string {
  const remaining = atMs - Date.now();
  if (remaining <= 0) return 'now';
  const hours = Math.floor(remaining / 3_600_000);
  if (hours >= 24) return `in ${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `in ${hours}h`;
  return `in ${Math.max(1, Math.round(remaining / 60_000))}m`;
}

function limitBarColor(usedPercent: number): string {
  if (usedPercent >= 90) return 'var(--color-status-error, #e05a6b)';
  if (usedPercent >= 70) return 'var(--color-status-warning, #e0913a)';
  return 'var(--color-status-success, #37b877)';
}

function LimitStatusBanners({ limits }: { limits: UsageRateLimitSample[] }) {
  const blocked = limits.find(l => l.rateLimitReachedType !== null);
  const spendControl = limits.find(l => l.spendControlReached === true);

  if (!blocked && !spendControl) return null;

  return (
    <div className="space-y-1.5">
      {blocked && (
        <div className="rounded border border-status-error/30 bg-status-error/10 px-3 py-1.5 text-[11px] text-text-primary">
          Rate limited — {blocked.rateLimitReachedType}
          {blocked.resetsAtMs && blocked.resetsAtMs > Date.now() && (
            <span className="text-text-tertiary"> · resets {formatReset(blocked.resetsAtMs)}</span>
          )}
        </div>
      )}
      {spendControl && (
        <div className="rounded border border-status-warning/30 bg-status-warning/10 px-3 py-1.5 text-[11px] text-text-primary">
          Organisation spend control reached
        </div>
      )}
    </div>
  );
}

function CreditsLine({ limits }: { limits: UsageRateLimitSample[] }) {
  const withCredits = limits.find(l => l.creditsHas !== null);
  if (!withCredits) return null;

  if (withCredits.creditsUnlimited) {
    return <p className="text-[10px] text-text-tertiary">Unlimited credits</p>;
  }

  if (withCredits.creditsHas && withCredits.creditsBalance) {
    return (
      <p className="text-[10px] text-text-tertiary">
        Credits remaining: ${withCredits.creditsBalance}
      </p>
    );
  }

  return null;
}

/** One limit of an account: its window, how much is left, and when it was reported. */
function LimitBar({ limit }: { limit: UsageRateLimitSample }) {
  const remaining = Math.max(0, Math.round(100 - limit.usedPercent));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-text-secondary">
          {limit.windowMinutes ? formatWindow(limit.windowMinutes) : 'Limit'}
          {limit.limitName && (
            <span className="ml-1 text-text-muted">· {limit.limitName}</span>
          )}
        </span>
        <span className="flex-shrink-0 tabular-nums text-text-primary">
          {remaining}% left
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(Math.max(limit.usedPercent, 0), 100)}%`,
            backgroundColor: limitBarColor(limit.usedPercent),
          }}
        />
      </div>
      <p className="mt-0.5 text-[10px] text-text-muted">
        Reported {formatAge(limit.capturedAtMs)}
        {limit.resetsAtMs
          ? limit.resetsAtMs <= Date.now()
            ? ' · window has since reset'
            : ` · resets ${formatReset(limit.resetsAtMs)}`
          : ''}
      </p>
    </div>
  );
}

/**
 * Each account once, with the machines signed in to it, its tokens in the range and its limits.
 * `several` names the machines, which only All machines with more than one machine needs.
 */
export function AccountsSection({ accounts, several }: { accounts: AccountUsage[]; several: boolean }) {
  const limits = accounts.flatMap(account => account.limits);
  return (
    <section className="rounded border border-border-primary bg-surface-secondary p-3" data-testid="usage-accounts">
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
        Accounts and limits
      </h2>

      <LimitStatusBanners limits={limits} />

      {accounts.length === 0 ? (
        <p className="mt-2 text-[11px] text-text-muted">
          No Claude Code or Codex sign-in found.
        </p>
      ) : (
        <ul className="mt-2 space-y-3">
          {accounts.map(account => (
            <li key={`${account.provider}-${account.key}`} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate text-text-primary" title={account.label}>
                  {PROVIDER_META[account.provider].label}
                  <span className="ml-1 text-text-secondary">· {account.label}</span>
                  {account.plan && <span className="ml-1 text-text-muted">· {account.plan}</span>}
                </span>
                <span className="flex-shrink-0 tabular-nums text-text-secondary">{formatTokens(account.tokens)} tokens</span>
              </div>
              {several && (
                <p className="text-[10px] text-text-tertiary">
                  {account.machines.length > 1 ? 'Shared by ' : 'Used on '}{account.machines.join(', ')}
                </p>
              )}
              {account.limits.map(limit => (
                <LimitBar key={`${limit.limitId}-${limit.scope}`} limit={limit} />
              ))}
              <CreditsLine limits={account.limits} />
              {account.limits.length === 0 && (
                <p className="text-[10px] text-text-muted">{PROVIDER_META[account.provider].noLimits}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Names each machine whose numbers are not live: offline or not answering, with when they were read. */
export function MachinesNotice({ machines, states }: { machines: MachineState[]; states: Record<string, MachineUsageState> }) {
  const notes = machines.flatMap(machine => {
    const state = states[machine.id];
    if (state?.kind !== 'stale') return [];
    const why = state.reason === 'offline' ? 'is offline' : 'did not answer';
    return [state.readAt === null
      ? `${machine.label} ${why} and has not been read since Pane opened, so its usage is not included.`
      : `${machine.label} ${why}. Its numbers are from its last read, ${formatAge(state.readAt)}.`];
  });
  if (notes.length === 0) return null;
  return (
    <div className="rounded border border-status-warning/30 bg-status-warning/10 px-3 py-1.5 text-[11px] text-text-primary" data-testid="usage-machines-notice">
      {notes.map(note => <p key={note}>{note}</p>)}
    </div>
  );
}
