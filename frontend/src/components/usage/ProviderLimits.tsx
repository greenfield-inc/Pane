import { RefreshCw } from 'lucide-react';
import { USAGE_PROVIDER_CATALOG, type UsageRateLimitSample } from '../../../../shared/types/usage';

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
        <div className="rounded border border-status-error/30 bg-status-error/10 px-3 py-1.5 text-[11px] text-status-error">
          Rate limited — {blocked.rateLimitReachedType}
          {blocked.resetsAtMs && blocked.resetsAtMs > Date.now() && (
            <span className="text-text-tertiary"> · resets {formatReset(blocked.resetsAtMs)}</span>
          )}
        </div>
      )}
      {spendControl && (
        <div className="rounded border border-status-warning/30 bg-status-warning/10 px-3 py-1.5 text-[11px] text-status-warning">
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

function LimitBar({ limit }: { limit: UsageRateLimitSample }) {
  const remaining = Math.max(0, Math.round(100 - limit.usedPercent));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="truncate text-text-secondary">
          {USAGE_PROVIDER_CATALOG[limit.provider].vendorLabel}
          {limit.planType && (
            <span className="ml-1 text-text-muted">· {limit.planType}</span>
          )}
          {limit.windowMinutes && (
            <span className="ml-1 text-text-muted">
              {formatWindow(limit.windowMinutes)}
            </span>
          )}
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
 * Provider-reported limits panel. Shared between Usage & Limits (full page)
 * and Settings > Usage (compact). Both read from `usage_rate_limits` via the
 * same `getReport()` path — one source of truth for limit display.
 */
export function ProviderLimitsPanel({
  limits,
  refreshing,
  onRefresh,
  className = '',
}: {
  limits: UsageRateLimitSample[];
  refreshing?: boolean;
  onRefresh?: () => void;
  className?: string;
}) {
  return (
    <section aria-label="Provider limits" className={`space-y-2 ${className}`}>
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
          Provider limits
        </h2>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Refresh usage"
            className="rounded p-1 transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 text-text-tertiary ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          </button>
        )}
      </div>

      <LimitStatusBanners limits={limits} />

      {limits.length > 0 ? (
        <ul className="space-y-2">
          {limits.map(limit => (
            <li key={`${limit.provider}-${limit.limitId}-${limit.scope}`}>
              <LimitBar limit={limit} />
            </li>
          ))}
          <CreditsLine limits={limits} />
        </ul>
      ) : (
        <p className="text-[11px] text-text-muted">
          No provider-reported limits available. Codex writes quota state
          into its transcripts; Anthropic does not expose plan limits locally.
        </p>
      )}
    </section>
  );
}
