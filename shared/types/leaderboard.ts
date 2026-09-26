import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';
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

export const leaderboardResponseSchema: BoundarySchema<LeaderboardResponse> = boundary.object({
  windowDays: boundary.literal(30),
  total: boundary.number,
  entries: boundary.array(boundary.object({
    rank: boundary.number,
    displayName: boundary.string,
    verified: boundary.boolean,
    estimatedCostUsd: boundary.number,
    costIncomplete: boundary.boolean,
    outputTokens: boundary.number,
    messageCount: boundary.number,
    topModel: boundary.nullable(boundary.string),
    installs: boundary.number,
    updatedAtMs: boundary.number,
  })),
  generatedAtMs: boundary.number,
});

export const leaderboardSubmitResultSchema: BoundarySchema<LeaderboardSubmitResult> = boundary.object({
  rank: boundary.number,
  displayName: boundary.string,
  verified: boundary.boolean,
  total: boundary.number,
  installs: boundary.number,
});
