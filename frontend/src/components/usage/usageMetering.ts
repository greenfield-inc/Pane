import type { UsageTotals } from '../../../../shared/types/usage';
import { formatTokens, formatUsd } from '../ui/charts/chartScales';

type MessageCounts = Pick<UsageTotals, 'messageCount' | 'unmeteredMessageCount'>;

/** A slice with messages, none of which recorded tokens (Cursor). Its token figures are absent, not zero. */
export function tokensUnreported(totals: MessageCounts): boolean {
  return totals.unmeteredMessageCount > 0 && totals.unmeteredMessageCount === totals.messageCount;
}

export function unreportedLabel(messageCount: number): string {
  return `${messageCount.toLocaleString()} messages · tokens not reported`;
}

/** A token figure for the slice, or "Not reported" when its messages recorded none. */
export function formatSliceTokens(totals: MessageCounts, tokens: number): string {
  return tokensUnreported(totals) ? 'Not reported' : formatTokens(tokens);
}

export const UNREPORTED_COST_TITLE = 'Cursor records messages but not their tokens, so there is no cost to estimate.';

export const UNREPORTED_CHART_TEXT = 'Cursor records messages but not their tokens, so there are no tokens to chart.';

type CostSlice = Pick<UsageTotals, 'messageCount' | 'unmeteredMessageCount' | 'costIncomplete'> & {
  byModel: ReadonlyArray<Pick<UsageTotals, 'unmeteredMessageCount' | 'costIncomplete'>>;
};

/**
 * Whether a slice's dollars are known except for Cursor messages, which carry
 * no cost. Every metered model must be priced, and some messages must be
 * metered: a Cursor-only slice has no dollars to show.
 */
function costKnownExceptCursor(slice: CostSlice): boolean {
  return slice.unmeteredMessageCount > 0
    && slice.unmeteredMessageCount < slice.messageCount
    && slice.byModel.every(model => model.unmeteredMessageCount > 0 || !model.costIncomplete);
}

/** Dollars, "~" dollars when only Cursor messages are unpriced, or "n/a". */
export function formatSliceCost(slice: CostSlice, costUsd: number): string {
  if (!slice.costIncomplete) return formatUsd(costUsd);
  return costKnownExceptCursor(slice) ? `~${formatUsd(costUsd)}` : 'n/a';
}

/** The note beside a "~" cost, or null when the cost is not shown that way. */
export function unpricedCursorNote(slice: CostSlice): string | null {
  if (!slice.costIncomplete || !costKnownExceptCursor(slice)) return null;
  return `+ ${slice.unmeteredMessageCount.toLocaleString()} Cursor messages, cost not reported`;
}
