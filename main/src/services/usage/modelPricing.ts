import type { ModelPrice } from '../../../../shared/types/usage';

/**
 * Date the bundled price table was last verified. Shown in the UI footer
 * when no live prices are available.
 */
const BUNDLED_PRICING_AS_OF = '2026-08-10';

/**
 * Bundled price table — the offline-last-resort fallback. Prices are USD per
 * 1M tokens. These go stale (which is why OpenRouter prices are preferred),
 * but they guarantee every model shipped in this build gets a price even with
 * no network.
 *
 * OpenAI publishes no separate cache-write price — writing to the prompt cache
 * bills at the standard input rate — so `cacheWritePerMTok` mirrors input for
 * those models.
 */
const BUNDLED_PRICES: ModelPrice[] = [
  // --- Anthropic (Claude Code) ---
  // Claude 5 family
  { model: 'claude-opus-5', inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  { model: 'claude-sonnet-5', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  { model: 'claude-fable-5', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  // Claude 4.x family (standard rates, verified 2026-09-25):
  // https://platform.claude.com/docs/en/about-claude/pricing
  { model: 'claude-opus-4-8', inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  { model: 'claude-opus-4-7', inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  { model: 'claude-opus-4-6', inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  { model: 'claude-opus-4-5', inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  { model: 'claude-opus-4', inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheWritePerMTok: 18.75 },
  { model: 'claude-sonnet-4', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  { model: 'claude-haiku-4-5', inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
  { model: 'claude-3-5-haiku', inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheWritePerMTok: 1 },

  // --- OpenAI (Codex) ---
  // Codex variants first: they are the models the Codex CLI actually reports.
  { model: 'gpt-5.3-codex', inputPerMTok: 1.75, outputPerMTok: 14, cacheReadPerMTok: 0.175, cacheWritePerMTok: 1.75 },
  { model: 'gpt-5.1-codex', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.25 },
  { model: 'gpt-5-codex', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.25 },
  // GPT-5.6 line
  { model: 'gpt-daybreak-blue-latest', inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.4, cacheWritePerMTok: 5 },
  { model: 'gpt-5.6-sol', inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, cacheWritePerMTok: 5 },
  { model: 'gpt-5.6-terra', inputPerMTok: 2, outputPerMTok: 12, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2 },
  { model: 'gpt-5.6-luna', inputPerMTok: 0.2, outputPerMTok: 1.2, cacheReadPerMTok: 0.02, cacheWritePerMTok: 0.2 },
  // GPT-5.5 / 5.4 lines
  { model: 'gpt-5.5-pro', inputPerMTok: 30, outputPerMTok: 180, cacheReadPerMTok: 30, cacheWritePerMTok: 30 },
  { model: 'gpt-5.5', inputPerMTok: 5, outputPerMTok: 30, cacheReadPerMTok: 0.5, cacheWritePerMTok: 5 },
  { model: 'gpt-5.4-pro', inputPerMTok: 30, outputPerMTok: 180, cacheReadPerMTok: 30, cacheWritePerMTok: 30 },
  { model: 'gpt-5.4-mini', inputPerMTok: 0.75, outputPerMTok: 4.5, cacheReadPerMTok: 0.075, cacheWritePerMTok: 0.75 },
  { model: 'gpt-5.4-nano', inputPerMTok: 0.2, outputPerMTok: 1.25, cacheReadPerMTok: 0.02, cacheWritePerMTok: 0.2 },
  { model: 'gpt-5.4', inputPerMTok: 2.5, outputPerMTok: 15, cacheReadPerMTok: 0.25, cacheWritePerMTok: 2.5 },
  // GPT-5.2 / 5.1 lines
  { model: 'gpt-5.2-pro', inputPerMTok: 21, outputPerMTok: 168, cacheReadPerMTok: 21, cacheWritePerMTok: 21 },
  { model: 'gpt-5.2', inputPerMTok: 1.75, outputPerMTok: 14, cacheReadPerMTok: 0.175, cacheWritePerMTok: 1.75 },
  { model: 'gpt-5.1', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.25 },
  // Base GPT-5 line
  { model: 'gpt-5-pro', inputPerMTok: 15, outputPerMTok: 120, cacheReadPerMTok: 15, cacheWritePerMTok: 15 },
  { model: 'gpt-5-mini', inputPerMTok: 0.25, outputPerMTok: 2, cacheReadPerMTok: 0.025, cacheWritePerMTok: 0.25 },
  { model: 'gpt-5-nano', inputPerMTok: 0.05, outputPerMTok: 0.4, cacheReadPerMTok: 0.005, cacheWritePerMTok: 0.05 },
  { model: 'gpt-5', inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.125, cacheWritePerMTok: 1.25 },
];

// ---------------------------------------------------------------------------
// Live price tier — set by the OpenRouter provider, checked first.
// ---------------------------------------------------------------------------

let livePrices: ModelPrice[] = [];
let livePricingSource: string | null = null;

export function setLivePrices(prices: ModelPrice[], source: string | null): void {
  livePrices = prices;
  livePricingSource = source;
}

export function getPricingSource(): string {
  return livePricingSource ?? `bundled · ${BUNDLED_PRICING_AS_OF}`;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function normalizeModelId(model: string): string {
  return model.toLowerCase().replace(/(claude-[a-z]+-\d+)\.(\d+)/g, '$1-$2');
}

function findInTable(model: string, table: readonly ModelPrice[]): ModelPrice | null {
  const normalized = normalizeModelId(model);
  let best: ModelPrice | null = null;
  for (const price of table) {
    // Substring matching lets short router ids like "auto" capture ids such as "codex-auto-review".
    if (!normalized.includes(normalizeModelId(price.model))) continue;
    if (!best || price.model.length > best.model.length) best = price;
  }
  return best;
}

/**
 * Match the longest model substring, normalizing Claude version separators, so dated ids (`claude-sonnet-5-20260101`) and
 * region-prefixed ids resolve to their base model.
 *
 * Checks live (OpenRouter) prices first, then falls back to the bundled table.
 */
export function findModelPrice(model: string): ModelPrice | null {
  if (!model) return null;
  return findInTable(model, livePrices) ?? findInTable(model, BUNDLED_PRICES);
}

export interface CostInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface CostEstimate {
  costUsd: number;
  complete: boolean;
  cacheSavingsUsd: number;
  cacheReadCostUsd: number;
}

/**
 * Estimate cost in USD. `complete` is false when the model has no price
 * entry, so the UI can mark the figure as a lower bound.
 *
 * `cacheSavingsUsd` is the counterfactual: what those cached input tokens
 * would have cost at the full input rate had the cache missed.
 */
export function estimateCostUsd(
  input: CostInput
): CostEstimate {
  const price = findModelPrice(input.model);
  if (!price || hasNegativeRate(price)) return { costUsd: 0, complete: false, cacheSavingsUsd: 0, cacheReadCostUsd: 0 };

  const perToken = 1_000_000;
  const costUsd =
    (input.inputTokens * price.inputPerMTok
      + input.outputTokens * price.outputPerMTok
      + input.cacheReadTokens * price.cacheReadPerMTok
      + input.cacheCreationTokens * price.cacheWritePerMTok) / perToken;

  const cacheSavingsUsd = Math.max(
    input.cacheReadTokens * (price.inputPerMTok - price.cacheReadPerMTok) / perToken,
    0
  );
  const cacheReadCostUsd = input.cacheReadTokens * price.cacheReadPerMTok / perToken;

  return { costUsd, complete: true, cacheSavingsUsd, cacheReadCostUsd };
}

function hasNegativeRate(price: ModelPrice): boolean {
  return [price.inputPerMTok, price.outputPerMTok, price.cacheReadPerMTok, price.cacheWritePerMTok]
    .some(rate => rate < 0);
}

export { BUNDLED_PRICES as MODEL_PRICES };
export { BUNDLED_PRICING_AS_OF as PRICING_AS_OF };
