import type { UsageByPaneReport } from '../../../../shared/types/usage';
import { formatTokens, formatUsd } from '../ui/charts/chartScales';

export function PaneUsageSummary({ byPane, trim, onTrimChange }: {
  byPane: UsageByPaneReport;
  trim: boolean;
  onTrimChange: (trim: boolean) => void;
}) {
  const panes = byPane.panes.filter(pane => pane.messageCount > 0);
  const count = panes.length;
  const cut = trim ? Math.floor(count * 0.1) : 0;
  const retained = count - cut * 2;
  const mean = (values: number[]): number => {
    const sample = values.sort((a, b) => a - b).slice(cut, count - cut);
    return sample.reduce((sum, value) => sum + value, 0) / retained;
  };
  const costIncomplete = panes.some(pane => pane.costIncomplete);
  const metrics = [
    {
      label: 'Tokens / pane',
      value: count ? formatTokens(mean(panes.map(pane => pane.inputTokens + pane.outputTokens + pane.cacheCreationTokens))) : '—',
      detail: 'Input + output + cache writes; excludes cache reads',
    },
    {
      label: 'Est. cost / pane',
      value: !count ? '—' : costIncomplete ? 'n/a' : formatUsd(mean(panes.map(pane => pane.estimatedCostUsd))),
      detail: costIncomplete ? 'Missing model prices in this sample' : 'All tokens at API rates, not subscription charges',
    },
    {
      label: 'Messages / pane',
      value: count ? mean(panes.map(pane => pane.messageCount)).toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—',
      detail: 'Recorded usage events, not human prompts',
    },
  ];

  return (
    <section data-testid="pane-usage-summary" aria-label="Per-pane usage" className="rounded border border-border-primary bg-surface-secondary p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">Per-pane usage</h2>
        <fieldset className="flex gap-1">
          <legend className="sr-only">Per-pane calculation</legend>
          {[{ label: 'Average', value: false }, { label: 'Trim 10%', value: true }].map(option => (
            <button
              key={option.label}
              type="button"
              aria-pressed={trim === option.value}
              onClick={() => onTrimChange(option.value)}
              className={`rounded px-2 py-1 text-[11px] ${trim === option.value ? 'bg-interactive text-text-on-interactive' : 'text-text-secondary hover:bg-surface-hover'}`}
            >
              {option.label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {metrics.map(metric => (
          <div key={metric.label} className="rounded border border-border-primary px-3 py-2">
            <h3 className="text-[10px] uppercase tracking-wider text-text-muted">{metric.label}</h3>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-primary">{metric.value}</p>
            <p className="text-[10px] text-text-tertiary">{metric.detail}</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-text-tertiary">
        {count ? `${count.toLocaleString()} panes with recorded usage in this period, including archived panes.` : 'No pane-attributed usage in this period.'}
        {' '}Empty panes and unattributed usage are excluded.
        {trim && ` Each metric drops its ${cut} highest and ${cut} lowest values; ${retained} panes remain per metric.`}
        {trim && count > 0 && cut === 0 && ' At least 10 panes are needed to trim.'}
      </p>
    </section>
  );
}
