import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { createPausableInterval, type PausableInterval } from '../../utils/pausableInterval';
import { join, dirname } from 'path';
import type { ModelPrice } from '../../../../shared/types/usage';
import { setLivePrices } from './modelPricing';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_FILENAME = 'openrouter-prices.json';
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

interface OpenRouterPricing {
  prompt?: string | null;
  completion?: string | null;
  input_cache_read?: string | null;
  input_cache_write?: string | null;
}

interface OpenRouterModel {
  id: string;
  pricing?: OpenRouterPricing;
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

export interface PersistedPriceTable {
  fetchedAtMs: number;
  fetchedAtIso: string;
  models: ModelPrice[];
}

/**
 * Strip the vendor prefix and filter out batch/fast variants.
 * Returns null for ids that should be skipped.
 */
export function normalizeOpenRouterId(id: string): string | null {
  if (id.includes(':')) return null;
  if (id.endsWith('-fast')) return null;

  const slashIdx = id.indexOf('/');
  return slashIdx >= 0 ? id.slice(slashIdx + 1) : id;
}

/**
 * Convert OpenRouter's USD-per-token string prices to USD-per-MTok numbers.
 * Returns null when the model has no usable pricing.
 */
export function convertPricing(
  bareId: string,
  pricing: OpenRouterPricing | undefined,
): ModelPrice | null {
  if (!pricing) return null;

  const prompt = pricing.prompt != null ? parseFloat(pricing.prompt) : NaN;
  const completion = pricing.completion != null ? parseFloat(pricing.completion) : NaN;
  if (isNaN(prompt) || isNaN(completion)) return null;

  const inputPerMTok = prompt * 1_000_000;
  const outputPerMTok = completion * 1_000_000;

  const cacheReadRaw = pricing.input_cache_read != null
    ? parseFloat(pricing.input_cache_read) : NaN;
  const cacheReadPerMTok = isNaN(cacheReadRaw) ? inputPerMTok : cacheReadRaw * 1_000_000;

  const cacheWriteRaw = pricing.input_cache_write != null
    ? parseFloat(pricing.input_cache_write) : NaN;
  const cacheWritePerMTok = isNaN(cacheWriteRaw) ? inputPerMTok : cacheWriteRaw * 1_000_000;

  if ([inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok].some(rate => rate < 0)) {
    return null;
  }

  return { model: bareId, inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok };
}

/** Parse the full OpenRouter response into a deduplicated ModelPrice table. */
export function parseOpenRouterResponse(data: OpenRouterResponse): ModelPrice[] {
  const seen = new Set<string>();
  const result: ModelPrice[] = [];

  for (const model of data.data) {
    const bareId = normalizeOpenRouterId(model.id);
    if (!bareId || seen.has(bareId)) continue;

    const price = convertPricing(bareId, model.pricing);
    if (!price) continue;

    seen.add(bareId);
    result.push(price);
  }

  return result;
}

export class OpenRouterPriceProvider {
  private refresh: PausableInterval | undefined;
  private cachePath: string;

  constructor(appDir: string) {
    this.cachePath = join(appDir, CACHE_FILENAME);
  }

  /** Load from disk (fast, sync) then schedule an async network fetch. */
  start(): void {
    this.loadFromDisk();
    void this.fetchAndUpdate();
    this.refresh = createPausableInterval(() => void this.fetchAndUpdate(), REFRESH_INTERVAL_MS);
  }

  /** While paused, scheduled refreshes wait; one runs on resume if any was due. */
  setPaused(paused: boolean): void {
    this.refresh?.setPaused(paused);
  }

  stop(): void {
    this.refresh?.stop();
    this.refresh = undefined;
  }

  private loadFromDisk(): void {
    try {
      const raw = readFileSync(this.cachePath, 'utf-8');
      const table: PersistedPriceTable = JSON.parse(raw);
      if (Array.isArray(table.models) && table.models.length > 0) {
        setLivePrices(table.models, `OpenRouter · ${table.fetchedAtIso}`);
        console.log(
          `[Usage] Loaded ${table.models.length} prices from disk cache (${table.fetchedAtIso})`,
        );
      }
    } catch {
      // No cached file yet — expected on first run.
    }
  }

  private async fetchAndUpdate(): Promise<void> {
    try {
      const response = await fetch(OPENROUTER_MODELS_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });

      if (!response.ok) {
        console.warn(`[Usage] OpenRouter fetch failed: HTTP ${response.status}`);
        return;
      }

      // SAFETY: The OpenRouter /models endpoint returns { data: OpenRouterModel[] }.
      // parseOpenRouterResponse validates each model's shape before use.
      const data = (await response.json()) as OpenRouterResponse;
      const prices = parseOpenRouterResponse(data);

      if (prices.length === 0) {
        console.warn('[Usage] OpenRouter returned no usable prices');
        return;
      }

      const now = new Date();
      const isoDate = now.toISOString().slice(0, 10);

      setLivePrices(prices, `OpenRouter · ${isoDate}`);
      this.persistToDisk({ fetchedAtMs: now.getTime(), fetchedAtIso: isoDate, models: prices });

      console.log(`[Usage] Updated ${prices.length} model prices from OpenRouter`);
    } catch (error) {
      console.warn(
        '[Usage] OpenRouter price fetch failed:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  private persistToDisk(table: PersistedPriceTable): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(table), 'utf-8');
    } catch (error) {
      console.warn(
        '[Usage] Failed to persist price cache:',
        error instanceof Error ? error.message : error,
      );
    }
  }
}
