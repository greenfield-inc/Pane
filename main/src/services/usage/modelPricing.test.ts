import { describe, it, expect, afterEach } from 'vitest';
import {
  findModelPrice,
  estimateCostUsd,
  MODEL_PRICES,
  PRICING_AS_OF,
  setLivePrices,
  getPricingSource,
} from './modelPricing';

afterEach(() => {
  setLivePrices([], null);
});

describe('findModelPrice', () => {
  it('keeps a dated GPT-5 identifier distinct from the GPT-5.2 family', () => {
    expect(estimateCostUsd({
      model: 'gpt-5-2025-08-07',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }).costUsd).toBe(11.25);
  });

  it('resolves Claude models from the bundled table', () => {
    expect(findModelPrice('claude-opus-5')?.model).toBe('claude-opus-5');
    expect(findModelPrice('claude-sonnet-5-20260101')?.model).toBe('claude-sonnet-5');
  });

  it('resolves OpenAI and Codex models', () => {
    expect(findModelPrice('gpt-5')?.model).toBe('gpt-5');
    expect(findModelPrice('gpt-5-codex')?.model).toBe('gpt-5-codex');
    expect(findModelPrice('gpt-5.3-codex')?.model).toBe('gpt-5.3-codex');
    expect(findModelPrice('gpt-5.6-terra')?.model).toBe('gpt-5.6-terra');
  });

  it('prefers the longest matching id so variants beat their base model', () => {
    expect(findModelPrice('gpt-5-mini')?.model).toBe('gpt-5-mini');
    expect(findModelPrice('gpt-5-nano')?.model).toBe('gpt-5-nano');
    expect(findModelPrice('gpt-5-pro')?.model).toBe('gpt-5-pro');
    expect(findModelPrice('gpt-5.4-mini')?.model).toBe('gpt-5.4-mini');
    expect(findModelPrice('gpt-5.5-pro')?.model).toBe('gpt-5.5-pro');
    expect(findModelPrice('gpt-5.1-codex')?.model).toBe('gpt-5.1-codex');
  });

  it('tolerates dated and prefixed ids', () => {
    expect(findModelPrice('gpt-5.3-codex-20260224')?.model).toBe('gpt-5.3-codex');
    expect(findModelPrice('openai/gpt-5-mini')?.model).toBe('gpt-5-mini');
    expect(findModelPrice('GPT-5-CODEX')?.model).toBe('gpt-5-codex');
  });

  it('returns null for unknown or empty models', () => {
    expect(findModelPrice('llama-4-70b')).toBeNull();
    expect(findModelPrice('')).toBeNull();
    expect(findModelPrice('codex')).toBeNull();
  });

  it('prefers live prices over bundled when both have the model', () => {
    setLivePrices(
      [{ model: 'claude-opus-5', inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 }],
      'OpenRouter · 2026-08-26',
    );

    const price = findModelPrice('claude-opus-5');
    expect(price?.inputPerMTok).toBe(5);
    expect(price?.outputPerMTok).toBe(25);
  });

  it('falls back to bundled when the model is not in live prices', () => {
    setLivePrices(
      [{ model: 'some-other-model', inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1 }],
      'OpenRouter · 2026-08-26',
    );

    expect(findModelPrice('gpt-daybreak-blue-latest')).toEqual({
      model: 'gpt-daybreak-blue-latest',
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.4,
      cacheWritePerMTok: 5,
    });
  });
});

describe('getPricingSource', () => {
  it('returns the bundled source when no live prices are set', () => {
    expect(getPricingSource()).toContain('bundled');
    expect(getPricingSource()).toContain(PRICING_AS_OF);
  });

  it('returns the live source after setLivePrices', () => {
    setLivePrices([], 'OpenRouter · 2026-08-26');
    expect(getPricingSource()).toBe('OpenRouter · 2026-08-26');
  });
});

describe('estimateCostUsd', () => {
  it('prices a Claude request across all four token classes', () => {
    const { costUsd, complete, cacheReadCostUsd } = estimateCostUsd({
      model: 'claude-opus-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(complete).toBe(true);
    // Bundled: 15 + 75 + 1.5 + 18.75 = 110.25
    expect(costUsd).toBeCloseTo(15 + 75 + 1.5 + 18.75, 6);
    expect(cacheReadCostUsd).toBeCloseTo(1.5, 6);
  });

  it.each(['claude-opus-4-5-20251101', 'anthropic/claude-opus-4.5', 'claude-opus-4-6', 'anthropic/claude-opus-4.7', 'claude-opus-4-8'])('prices %s at its published standard rates', model => {
    const result = estimateCostUsd({ model, inputTokens: 1_000_000, outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000, cacheCreationTokens: 1_000_000 });
    // Anthropic standard USD/MTok: input 5, output 25, cache read .50, 5-minute write 6.25.
    expect(result.complete).toBe(true);
    expect(result.costUsd).toBeCloseTo(36.75, 6);
    expect(result.cacheReadCostUsd).toBeCloseTo(0.5, 6);
  });

  it('prices a Codex request', () => {
    const { costUsd, complete } = estimateCostUsd({
      model: 'gpt-5-codex',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(complete).toBe(true);
    expect(costUsd).toBeCloseTo(11.25, 6);
  });

  it('reports incomplete rather than guessing for an unknown model', () => {
    const { costUsd, complete } = estimateCostUsd({
      model: 'mystery-model',
      inputTokens: 5_000_000,
      outputTokens: 5_000_000,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(complete).toBe(false);
    expect(costUsd).toBe(0);
  });

  it('reports incomplete when a live price contains a negative rate', () => {
    setLivePrices(
      [{ model: 'negative-model', inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: -1, cacheWritePerMTok: 1 }],
      'stale cache',
    );

    const { costUsd, complete } = estimateCostUsd({
      model: 'negative-model',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });

    expect(complete).toBe(false);
    expect(costUsd).toBe(0);
  });

  it('does not price codex-auto-review through a negative auto router entry', () => {
    setLivePrices(
      [{
        model: 'auto',
        inputPerMTok: -1_000_000,
        outputPerMTok: -1_000_000,
        cacheReadPerMTok: -1_000_000,
        cacheWritePerMTok: -1_000_000,
      }],
      'stale cache',
    );

    const { costUsd, complete } = estimateCostUsd({
      model: 'codex-auto-review',
      inputTokens: 100_000_000,
      outputTokens: 10_000_000,
      cacheReadTokens: 50_000_000,
      cacheCreationTokens: 0,
    });

    expect(complete).toBe(false);
    expect(costUsd).toBe(0);
  });

  it('returns zero for zero tokens', () => {
    expect(estimateCostUsd({
      model: 'gpt-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }).costUsd).toBe(0);
  });

  it('uses live prices when available', () => {
    setLivePrices(
      [{ model: 'claude-opus-5', inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 }],
      'test',
    );
    const { costUsd } = estimateCostUsd({
      model: 'claude-opus-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(costUsd).toBeCloseTo(5 + 25 + 0.5 + 6.25, 6);
  });
});

describe('price table integrity', () => {
  it('covers both providers', () => {
    expect(MODEL_PRICES.some(p => p.model.startsWith('claude-'))).toBe(true);
    expect(MODEL_PRICES.some(p => p.model.startsWith('gpt-'))).toBe(true);
  });

  it('has no duplicate model ids', () => {
    const ids = MODEL_PRICES.map(p => p.model);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has non-negative prices and output at least input', () => {
    for (const price of MODEL_PRICES) {
      expect(price.inputPerMTok).toBeGreaterThan(0);
      expect(price.outputPerMTok).toBeGreaterThanOrEqual(price.inputPerMTok);
      expect(price.cacheReadPerMTok).toBeGreaterThanOrEqual(0);
      expect(price.cacheWritePerMTok).toBeGreaterThanOrEqual(0);
    }
  });

  it('carries a parseable bundled as-of date', () => {
    expect(Number.isNaN(Date.parse(PRICING_AS_OF))).toBe(false);
  });
});
