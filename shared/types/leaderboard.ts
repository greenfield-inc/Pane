import type { UsageProvider } from './usage';

export interface LeaderboardSubmission {
  installId: string;
  githubUsername?: string;
  gitEmailHash?: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messageCount: number;
  estimatedCostUsd: number;
  costIncomplete: boolean;
  cacheSavingsUsd: number;
  byModel: LeaderboardModelEntry[];
  windowDays: 30;
  submittedAtMs: number;
  paneVersion: string;
}

export interface LeaderboardModelEntry {
  model: string;
  provider: UsageProvider;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  /** Cursor rows carry only this: their tokens and cost are unmetered, so 0 with costIncomplete. */
  messageCount: number;
  estimatedCostUsd: number;
  costIncomplete: boolean;
}

export interface LeaderboardSubmitResult {
  rank: number;
  displayName: string;
  verified: boolean;
  total: number;
  installs: number;
}

export interface LeaderboardEntry {
  rank: number;
  displayName: string;
  verified: boolean;
  estimatedCostUsd: number;
  costIncomplete: boolean;
  outputTokens: number;
  messageCount: number;
  topModel: string | null;
  installs: number;
  updatedAtMs: number;
}

export interface LeaderboardResponse {
  windowDays: 30;
  total: number;
  entries: LeaderboardEntry[];
  generatedAtMs: number;
}

export interface LeaderboardConfig {
  optIn: boolean;
  joinedAtMs?: number;
  lastSubmittedAtMs?: number;
  lastRank?: number;
  lastDisplayName?: string;
}

export interface LeaderboardStatus {
  optIn: boolean;
  lastRank: number | null;
  lastDisplayName: string | null;
  lastSubmittedAtMs: number | null;
  doNotTrack: boolean;
}
