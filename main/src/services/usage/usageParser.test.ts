import { describe, it, expect } from 'vitest';
import { parseUsageLine, parseClaudeLine, parseCodexLine, usageEventId, createCodexContext } from './usageParser';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';

const FALLBACK_MS = 1_700_000_000_000;

function claudeLine(overrides: JsonObject = {}, usage: JsonObject = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-01T10:00:00.000Z',
    sessionId: 'sess-1',
    cwd: '/repo',
    message: {
      id: 'msg_123',
      model: 'claude-sonnet-5-20260101',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
        ...usage,
      },
      ...overrides,
    },
  });
}

describe('parseClaudeLine', () => {
  it('extracts tokens, model, timestamp and identity', () => {
    const event = parseUsageLine('claude', claudeLine(), FALLBACK_MS);

    expect(event).toMatchObject({
      provider: 'claude',
      model: 'claude-sonnet-5-20260101',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      messageId: 'msg_123',
      agentSessionId: 'sess-1',
      cwd: '/repo',
    });
    expect(event?.timestampMs).toBe(Date.parse('2026-05-01T10:00:00.000Z'));
  });

  it('sums the nested cache_creation breakdown used by newer builds', () => {
    const line = claudeLine({}, {
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 },
    });

    expect(parseUsageLine('claude', line, FALLBACK_MS)?.cacheCreationTokens).toBe(500);
  });

  it('prefers the flat cache_creation_input_tokens when it is non-zero', () => {
    const line = claudeLine({}, {
      cache_creation_input_tokens: 42,
      cache_creation: { ephemeral_5m_input_tokens: 999 },
    });

    expect(parseUsageLine('claude', line, FALLBACK_MS)?.cacheCreationTokens).toBe(42);
  });

  it('falls back to the file mtime when the line has no timestamp', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-5', usage: { input_tokens: 5, output_tokens: 1 } },
    });

    expect(parseUsageLine('claude', line, FALLBACK_MS)?.timestampMs).toBe(FALLBACK_MS);
  });

  it('ignores non-assistant lines', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'hi' } });
    expect(parseUsageLine('claude', line, FALLBACK_MS)).toBeNull();
  });

  it('ignores assistant lines without usage', () => {
    const line = JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5' } });
    expect(parseUsageLine('claude', line, FALLBACK_MS)).toBeNull();
  });

  it('ignores a usage object with all-zero counts', () => {
    const line = claudeLine({}, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(parseUsageLine('claude', line, FALLBACK_MS)).toBeNull();
  });

  it('labels a missing model as unknown rather than dropping the event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 10, output_tokens: 2 } },
    });
    expect(parseClaudeLine(JSON.parse(line), FALLBACK_MS)?.model).toBe('unknown');
  });
});

/**
 * Fixtures below mirror what the Codex CLI actually writes, taken from real
 * rollout transcripts rather than assumed.
 */
function tokenCountLine(usage: Record<string, number>, cumulative?: Record<string, number>) {
  return JSON.stringify({
    timestamp: '2026-05-01T11:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: usage,
        total_token_usage: cumulative ?? usage,
        model_context_window: 258400,
      },
    },
  });
}

const TURN_CONTEXT = JSON.stringify({
  timestamp: '2026-05-01T10:59:00.000Z',
  type: 'turn_context',
  payload: { model: 'gpt-5.6-sol', cwd: 'D:\\repo' },
});

const SESSION_META = JSON.stringify({
  timestamp: '2026-05-01T10:58:00.000Z',
  type: 'session_meta',
  payload: { id: 'codex-session-1', cwd: 'D:\\repo', model_provider: 'openai' },
});

describe('parseCodexLine', () => {
  it('reads last_token_usage from a token_count event', () => {
    const line = tokenCountLine({
      input_tokens: 18179,
      cached_input_tokens: 4096,
      cache_write_input_tokens: 100,
      output_tokens: 52,
      reasoning_output_tokens: 34,
      total_tokens: 18231,
    });

    expect(parseUsageLine('codex', line, FALLBACK_MS)).toMatchObject({
      provider: 'codex',
      // input_tokens includes the cached part; they are priced separately.
      inputTokens: 18179 - 4096,
      cacheReadTokens: 4096,
      cacheCreationTokens: 100,
      outputTokens: 52,
    });
  });

  it('attributes model, session and cwd from earlier context lines', () => {
    const context = createCodexContext();
    parseUsageLine('codex', SESSION_META, FALLBACK_MS, context);
    parseUsageLine('codex', TURN_CONTEXT, FALLBACK_MS, context);

    const event = parseUsageLine(
      'codex',
      tokenCountLine({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 }),
      FALLBACK_MS,
      context
    );

    expect(event).toMatchObject({
      model: 'gpt-5.6-sol',
      agentSessionId: 'codex-session-1',
      cwd: 'D:\\repo',
    });
  });

  it('never accumulates the cumulative total_token_usage', () => {
    // Three turns of a session: totals grow, deltas do not.
    const context = createCodexContext();
    const lines = [
      tokenCountLine({ input_tokens: 100, output_tokens: 10 }, { input_tokens: 100, output_tokens: 10 }),
      tokenCountLine({ input_tokens: 120, output_tokens: 12 }, { input_tokens: 220, output_tokens: 22 }),
      tokenCountLine({ input_tokens: 130, output_tokens: 13 }, { input_tokens: 350, output_tokens: 35 }),
    ];

    const total = lines
      .map(line => parseUsageLine('codex', line, FALLBACK_MS, context))
      .reduce((sum, event) => sum + (event?.inputTokens ?? 0), 0);

    // Sum of the deltas, not of the running totals (which would be 670).
    expect(total).toBe(350);
  });

  it('captures the provider-reported quota state', () => {
    const context = createCodexContext();
    const line = JSON.stringify({
      timestamp: '2026-05-01T11:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 59, window_minutes: 10080, resets_at: 1785497199 },
          secondary: null,
          plan_type: 'plus',
        },
      },
    });

    parseUsageLine('codex', line, FALLBACK_MS, context);
    const limits = [...context.rateLimits.values()];

    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      provider: 'codex',
      limitId: 'codex',
      scope: 'primary',
      usedPercent: 59,
      windowMinutes: 10080,
      planType: 'plus',
      // resets_at is epoch seconds and must be promoted to milliseconds.
      resetsAtMs: 1785497199 * 1000,
    });
  });

  it('captures credits, rate_limit_reached_type, spend_control_reached, and limit_name', () => {
    const context = createCodexContext();
    const line = JSON.stringify({
      timestamp: '2026-05-01T11:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 80, window_minutes: 300, resets_at: 1785497199 },
          plan_type: 'pro',
          limit_name: 'Standard rate limit',
          rate_limit_reached_type: 'hard_cap',
          spend_control_reached: true,
          credits: { has_credits: true, balance: '42.50', unlimited: false },
        },
      },
    });

    parseUsageLine('codex', line, FALLBACK_MS, context);
    const limits = [...context.rateLimits.values()];

    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      limitName: 'Standard rate limit',
      rateLimitReachedType: 'hard_cap',
      spendControlReached: true,
      creditsHas: true,
      creditsBalance: '42.50',
      creditsUnlimited: false,
    });
  });

  it('captures credits, blocked and spend-control fields', () => {
    const context = createCodexContext();
    const line = JSON.stringify({
      timestamp: '2026-05-01T11:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
        rate_limits: {
          limit_id: 'codex',
          limit_name: 'api-codex',
          primary: { used_percent: 80, window_minutes: 10080, resets_at: 1785497199 },
          secondary: null,
          credits: { has_credits: true, unlimited: false, balance: '42.50' },
          plan_type: 'pro',
          rate_limit_reached_type: 'weekly',
          spend_control_reached: true,
        },
      },
    });

    parseUsageLine('codex', line, FALLBACK_MS, context);
    const limits = [...context.rateLimits.values()];

    expect(limits).toHaveLength(1);
    expect(limits[0]).toMatchObject({
      creditsHas: true,
      creditsBalance: '42.50',
      creditsUnlimited: false,
      rateLimitReachedType: 'weekly',
      spendControlReached: true,
      limitName: 'api-codex',
    });
  });

  it('handles missing credits and null blocked/spend fields', () => {
    const context = createCodexContext();
    const line = JSON.stringify({
      timestamp: '2026-05-01T11:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } },
        rate_limits: {
          limit_id: 'codex',
          primary: { used_percent: 19, window_minutes: 10080 },
          secondary: null,
          plan_type: 'pro',
          rate_limit_reached_type: null,
          spend_control_reached: null,
        },
      },
    });

    parseUsageLine('codex', line, FALLBACK_MS, context);
    const limits = [...context.rateLimits.values()];

    expect(limits[0]).toMatchObject({
      creditsHas: null,
      creditsBalance: null,
      creditsUnlimited: null,
      rateLimitReachedType: null,
      spendControlReached: null,
      limitName: null,
    });
  });

  it('keeps the newest quota sample when several appear', () => {
    const context = createCodexContext();
    const sample = (ts: string, used: number) => JSON.stringify({
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } },
        rate_limits: { limit_id: 'codex', primary: { used_percent: used, window_minutes: 300 } },
      },
    });

    parseUsageLine('codex', sample('2026-05-01T10:00:00.000Z', 20), FALLBACK_MS, context);
    parseUsageLine('codex', sample('2026-05-01T12:00:00.000Z', 65), FALLBACK_MS, context);
    parseUsageLine('codex', sample('2026-05-01T11:00:00.000Z', 40), FALLBACK_MS, context);

    expect([...context.rateLimits.values()][0].usedPercent).toBe(65);
  });

  it('context lines themselves produce no usage event', () => {
    const context = createCodexContext();
    expect(parseUsageLine('codex', SESSION_META, FALLBACK_MS, context)).toBeNull();
    expect(parseUsageLine('codex', TURN_CONTEXT, FALLBACK_MS, context)).toBeNull();
  });

  it('falls back to a generic model label with no context', () => {
    const line = tokenCountLine({ input_tokens: 1, output_tokens: 1 });
    expect(parseCodexLine(JSON.parse(line), FALLBACK_MS)?.model).toBe('codex');
  });

  it('ignores other event types and zero-token turns', () => {
    expect(parseUsageLine('codex', JSON.stringify({ type: 'response_item', payload: {} }), FALLBACK_MS)).toBeNull();
    expect(parseUsageLine('codex', tokenCountLine({ input_tokens: 0, output_tokens: 0 }), FALLBACK_MS)).toBeNull();
  });
});

describe('parseUsageLine robustness', () => {
  it('returns null for blank lines, prose and malformed JSON', () => {
    expect(parseUsageLine('claude', '', FALLBACK_MS)).toBeNull();
    expect(parseUsageLine('claude', '   ', FALLBACK_MS)).toBeNull();
    expect(parseUsageLine('claude', 'not json at all', FALLBACK_MS)).toBeNull();
    expect(parseUsageLine('claude', '{"type":"assistant"', FALLBACK_MS)).toBeNull();
  });

  it('returns null for a JSON array rather than throwing', () => {
    expect(parseUsageLine('claude', '[1,2,3]', FALLBACK_MS)).toBeNull();
  });
});

describe('usageEventId', () => {
  it('prefers the provider message id so re-scans dedupe', () => {
    const event = parseUsageLine('claude', claudeLine(), FALLBACK_MS)!;
    expect(usageEventId(event, '/t.jsonl', 512)).toBe('claude:msg_123');
  });

  it('falls back to path and offset when there is no message id', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const event = parseUsageLine('claude', line, FALLBACK_MS)!;
    expect(usageEventId(event, '/t.jsonl', 512)).toBe('/t.jsonl:512');
  });
});

describe('Cursor transcript lines', () => {
  it('counts an assistant line as one unmetered message at the file time', () => {
    const line = JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });

    expect(parseUsageLine('cursor', line, FALLBACK_MS)).toEqual({
      provider: 'cursor',
      timestampMs: FALLBACK_MS,
      model: 'cursor',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      metered: false,
      agentSessionId: null,
      messageId: null,
      cwd: null,
    });
  });

  it('ignores user lines, turn markers and token-shaped keys', () => {
    expect(parseUsageLine('cursor', JSON.stringify({ role: 'user', message: { content: 'hi' } }), FALLBACK_MS)).toBeNull();
    expect(parseUsageLine('cursor', JSON.stringify({ type: 'turn_ended' }), FALLBACK_MS)).toBeNull();
    const withUsage = parseUsageLine('cursor', JSON.stringify({ role: 'assistant', usage: { input_tokens: 99 } }), FALLBACK_MS);
    expect(withUsage).toMatchObject({ inputTokens: 0, metered: false });
  });
});

describe('metered events', () => {
  it('marks Claude and Codex token accounting as measured', () => {
    expect(parseUsageLine('claude', claudeLine(), FALLBACK_MS)?.metered).toBe(true);
  });
});
