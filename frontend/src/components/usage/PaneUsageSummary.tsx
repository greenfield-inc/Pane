import type { UsageByPaneReport } from '../../../../shared/types/usage';
import { formatTokens } from '../ui/charts/chartScales';
import { formatSliceCost, tokensUnreported, unpricedCursorNote } from './usageMetering';

export function PaneUsageSummary({ byPane, trim, onTrimChange }: {
  byPane: UsageByPaneReport;
  trim: boolean;
  onTrimChange: (trim: boolean) => void;
}) {
  const panes = byPane.panes.filter(pane => pane.messageCount > 0);
  const count = panes.length;
  const cut = trim ? Math.floor(count * 0.1) : 0;
  const retained = count - cut * 2;
  // Trimmed per metric, since a metric may average a subset of the panes.
  const mean = (values: number[]): number => {
    const cut = trim ? Math.floor(values.length * 0.1) : 0;
    const sample = values.sort((a, b) => a - b).slice(cut, values.length - cut);
    return sample.reduce((sum, value) => sum + value, 0) / sample.length;
  };
  const costIncomplete = panes.some(pane => pane.costIncomplete);
  const unmetered = panes.some(pane => pane.unmeteredMessageCount > 0);
  // Panes whose messages recorded no tokens (Cursor) would average in as 0.
  const tokenPanes = panes.filter(pane => !tokensUnreported(pane));
  const tokenCut = trim ? Math.floor(tokenPanes.length * 0.1) : 0;
  const priceMissing = panes.some(pane => pane.byModel.some(model => model.costIncomplete && model.unmeteredMessageCount === 0));
  // The sample as one slice, so its cost reads the way a pane's does.
  const sample = {
    messageCount: panes.reduce((sum, pane) => sum + pane.messageCount, 0),
    unmeteredMessageCount: panes.reduce((sum, pane) => sum + pane.unmeteredMessageCount, 0),
    costIncomplete,
    byModel: panes.flatMap(pane => pane.byModel),
  };
  const metrics = [
    {
      label: 'Tokens / pane',
      value: !count ? '—' : tokenPanes.length === 0 ? 'Not reported' : formatTokens(mean(tokenPanes.map(pane => pane.inputTokens + pane.outputTokens + pane.cacheCreationTokens))),
      detail: unmetered
        ? 'Input + output + cache writes; Cursor messages carry no tokens'
        : 'Input + output + cache writes; excludes cache reads',
    },
    {
      label: 'Est. cost / pane',
      // Cursor-only panes have no dollars, so the mean is over panes that recorded tokens.
      value: !count || tokenPanes.length === 0 ? '—' : formatSliceCost(sample, mean(tokenPanes.map(pane => pane.estimatedCostUsd))),
      detail: !costIncomplete
        ? 'All tokens at API rates, not subscription charges'
        : unpricedCursorNote(sample) ?? (unmetered && !priceMissing
          ? 'Cursor messages carry no tokens to price'
          : 'Missing model prices in this sample'),
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
        {tokenPanes.length > 0 && tokenPanes.length < count && ` Tokens / pane and Est. cost / pane average the ${tokenPanes.length.toLocaleString()} panes that recorded tokens.`}
        {trim && (tokenPanes.length < count
          ? ` Tokens and cost drop ${tokenCut} from each end, so ${tokenPanes.length - tokenCut * 2} panes remain. Messages drop ${cut} highest and ${cut} lowest values; ${retained} panes remain.`
          : ` Each metric drops its ${cut} highest and ${cut} lowest values; ${retained} panes remain per metric.`)}
        {trim && count > 0 && cut === 0 && ' At least 10 panes are needed to trim.'}
      </p>
    </section>
  );
}
