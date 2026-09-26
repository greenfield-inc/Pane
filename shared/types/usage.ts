/**
 * Token usage, cost and rate-limit types.
 *
 * Pane runs Claude and Codex as PTY terminals, so no structured usage flows
 * through the app itself. The authoritative record is each CLI's own transcript
 * (`~/.claude/projects/**\/*.jsonl`, `~/.codex/sessions/**\/*.jsonl`), which
 * Pane reads read-only and indexes incrementally.
 */

/** Agent names identify filters; vendor names identify reported usage and limits. */
export const USAGE_PROVIDER_CATALOG = {
  claude: { value: 'claude', label: 'Claude', vendorLabel: 'Anthropic', color: '#e0913a' },
  codex: { value: 'codex', label: 'Codex', vendorLabel: 'OpenAI', color: '#37b877' },
} as const;

export type UsageProvider = keyof typeof USAGE_PROVIDER_CATALOG;

/** One assistant message's token accounting, normalised across providers. */
export interface UsageEvent {
  provider: UsageProvider;
  /** Epoch milliseconds — the indexed column. */
  timestampMs: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Provider session id from the transcript, when present. */
  agentSessionId: string | null;
  /** Message id — the primary dedupe key across re-scans. */
  messageId: string | null;
  /** Working directory recorded in the transcript, for project attribution. */
  cwd: string | null;
}

export interface ModelPrice {
  model: string;
  /** USD per 1M tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  messageCount: number;
  estimatedCostUsd: number;
  /** True when at least one model in the range had no price entry. */
  costIncomplete: boolean;
  /**
   * What the cached input would have cost at the full input rate, minus what
   * it did cost. With cache reads running two orders of magnitude above fresh
   * input, this is the single largest lever on the bill.
   */
  cacheSavingsUsd: number;
}

export interface UsageBucket extends UsageTotals {
  /** Bucket start, epoch milliseconds. */
  bucketStartMs: number;
}

export interface UsageByModel extends UsageTotals {
  model: string;
  provider: UsageProvider;
}

export interface UsagePaneCostSlice extends UsageTotals {
  uncachedCostUsd: number;
  uncachedInputTokens: number;
  cacheHitRate: number;
  byModel: UsageByModel[];
}

/**
 * Usage attributed to one Pane by matching an event's cwd to its worktree,
 * bounded by the Pane's creation time and, when archived, its update time.
 * If lifetimes overlap on one path, the newest matching Pane wins.
 */
export interface UsageByPane extends UsagePaneCostSlice {
  paneId: string;
  paneName: string;
  worktreePath: string;
  repoId: number | null;
  archived: boolean;
  createdAtMs: number;
}

export interface UsageByPaneReport {
  panes: UsageByPane[];
  unattributed: UsagePaneCostSlice;
}

/**
 * Usage attributed to the directory the agent ran in.
 *
 * Both CLIs record their working directory per message, which is the only
 * link back to a Pane project or worktree — the transcripts know nothing about
 * Pane's own session model.
 */
export interface UsageByProject extends UsageTotals {
  /** Absolute working directory as the transcript recorded it. */
  path: string;
  /** Last path segment — the worktree or repo folder name. */
  label: string;
}

export const MAX_USAGE_DAY_BUCKETS = 10_000;

export interface UsageReportRequest {
  /** Inclusive epoch-ms range. Defaults to the last 30 days. */
  fromMs?: number;
  toMs?: number;
  bucket?: 'hour' | 'day';
  /** Viewer-local midnight boundaries, including the exclusive end, for custom calendar charts. */
  dayBoundariesMs?: number[];
  providers?: UsageProvider[];
}

/** Health of the background transcript index, surfaced in the page header. */
export interface UsageIndexStatus {
  lastScanStartedMs: number | null;
  /** Last successful full scan; failed or canceled passes do not advance it. */
  lastScanFinishedMs: number | null;
  filesTracked: number;
  eventsIndexed: number;
  /** Transcript roots that do not exist — drives the empty state. */
  missingRoots: string[];
  scanning: boolean;
  /** Files scanned so far in the current pass, for a progress indicator. */
  filesScanned: number;
  filesTotal: number;
  lastError: string | null;
}

/**
 * A rate limit as the provider itself reported it.
 *
 * Codex writes its live quota state into every `token_count` event, which
 * makes this a measured figure rather than an estimate. Claude Code's
 * transcripts carry no equivalent — Anthropic does not expose plan limits
 * in the local transcript files.
 */
export interface UsageRateLimitSample {
  provider: UsageProvider;
  limitId: string;
  scope: 'primary' | 'secondary';
  /** 0-100, as reported. */
  usedPercent: number;
  windowMinutes: number | null;
  resetsAtMs: number | null;
  /** Subscription tier, when the provider names it. */
  planType: string | null;
  capturedAtMs: number;
  /** Whether the account has any credits balance. */
  creditsHas: boolean | null;
  /** Credit balance as reported by the provider (string to preserve precision). */
  creditsBalance: string | null;
  /** Whether the account has unlimited credits. */
  creditsUnlimited: boolean | null;
  /** Non-null when the user is actively rate-limited; names the kind of limit hit. */
  rateLimitReachedType: string | null;
  /** True when the organisation's spend control has been reached. */
  spendControlReached: boolean | null;
  /** Provider's own display name for this limit window. */
  limitName: string | null;
}

export interface UsageReport {
  totals: UsageTotals;
  series: UsageBucket[];
  byModel: UsageByModel[];
  /** Busiest working directories in the range, largest first. */
  byProject: UsageByProject[];
  byPane: UsageByPaneReport;
  /** Provider-reported quota state; empty when nobody reported any. */
  rateLimits: UsageRateLimitSample[];
  index: UsageIndexStatus;
  /** Pricing source and date, shown in the footer (e.g. "OpenRouter · 2026-08-26"). */
  pricingAsOf: string;
}

/**
 * Bumped whenever the transcript parsers change in a way that alters the
 * events they produce. Files indexed by an older parser are re-read from the
 * start instead of being silently trusted — otherwise a fix would only apply
 * to transcripts written after it.
 *
 * v2: Codex `token_count` events parsed from `last_token_usage` (v1 read the
 *     wrong shape entirely and recorded nothing).
 * v3: Codex attribution carried across an incremental scan. Every event a
 *     resumed pass produced before this was filed under model `codex` with no
 *     session and no cwd, so those rows have to be read again.
 * v4: Codex rate-limit fields that the provider reports but v3 dropped:
 *     credits, rate_limit_reached_type, spend_control_reached, limit_name.
 */
export const USAGE_PARSER_VERSION = 4;
export const DEFAULT_USAGE_RANGE_DAYS = 30;
/** Events older than this are swept at startup to bound the table. */
export const USAGE_RETENTION_DAYS = 180;
