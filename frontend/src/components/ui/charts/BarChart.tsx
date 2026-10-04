import { linearScale, niceMax } from './chartScales';

interface BarDatum {
  label: string;
  value: number;
  color: string;
  /** Optional secondary text shown at the right of the row. */
  detail?: string;
  /** Small chip before the label, e.g. the provider. */
  tag?: string;
  /** Share of the total, 0-1, rendered next to the value. */
  share?: number;
  /** Hover text for the label — full path, or why a detail reads "n/a". */
  title?: string;
  /** Hover text for the detail column. */
  detailTitle?: string;
  /** Extra chip after the label, e.g. "no price". */
  note?: string;
  /** Shown instead of the formatted value, e.g. a message count when no tokens were recorded. */
  valueText?: string;
}

/**
 * Percentages, without lying by rounding.
 *
 * A model with 13 million tokens next to one with 5.6 billion is a real 0.2%,
 * and printing "0%" makes it look like a bug rather than a ratio.
 */
function formatShare(share: number): string {
  const percent = share * 100;
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}

/**
 * Smallest rendered bar width, in percent.
 *
 * Usage is wildly skewed — one model can be four orders of magnitude larger
 * than the next — and a purely proportional bar renders the rest as invisible
 * slivers. A floor keeps every row readable as a row.
 */
const MIN_BAR_PERCENT = 1.5;

export interface BarChartProps {
  data: BarDatum[];
  formatValue: (value: number) => string;
  ariaLabel: string;
}

/**
 * Horizontal bar chart rendered with plain divs rather than SVG.
 *
 * Horizontal bars need to carry long, wrapping labels (model ids), which HTML
 * handles far better than SVG text. Each row is also a `<tr>`-shaped list item
 * so the numbers stay readable to a screen reader without a parallel table.
 */
export function BarChart({ data, formatValue, ariaLabel }: BarChartProps) {
  if (data.length === 0) {
    return <p className="py-6 text-center text-xs text-text-muted">No data in this range.</p>;
  }

  const max = niceMax(Math.max(...data.map(datum => datum.value), 1));

  return (
    <ul className="space-y-1.5" aria-label={ariaLabel}>
      {data.map(datum => {
        const widthPercent = datum.value > 0
          ? Math.max(linearScale(datum.value, 0, max, 0, 100), MIN_BAR_PERCENT)
          : 0;
        return (
          <li key={datum.label} className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="flex min-w-0 items-baseline gap-1.5">
                {datum.tag && (
                  <span className="flex-shrink-0 rounded-sm bg-surface-tertiary px-1 text-[9px] uppercase tracking-wide text-text-muted">
                    {datum.tag}
                  </span>
                )}
                <span className="truncate font-mono text-text-secondary" title={datum.title ?? datum.label}>
                  {datum.label}
                </span>
                {datum.note && (
                  <span className="flex-shrink-0 rounded-sm border border-border-secondary px-1 text-[9px] text-text-muted">
                    {datum.note}
                  </span>
                )}
              </span>
              <span className="flex flex-shrink-0 items-baseline gap-2 tabular-nums text-text-tertiary">
                {datum.share !== undefined && (
                  <span className="text-text-muted">{formatShare(datum.share)}</span>
                )}
                <span>{datum.valueText ?? formatValue(datum.value)}</span>
                {datum.detail && (
                  <span className="w-16 text-right text-text-muted" title={datum.detailTitle}>
                    {datum.detail}
                  </span>
                )}
              </span>
            </div>
            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-tertiary">
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${widthPercent}%`, backgroundColor: datum.color }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
