export type VoiceTranscriptionMode = 'recorded' | 'streaming';
export type VoiceTranscriptionProvider = 'fal-ai/wizper' | 'deepgram/nova-3';
export type VoiceTranscriptionCleanupModel = 'google/gemini-3.1-flash-lite';
export type VoiceTranscriptionCostSource = 'provider' | 'metadata' | 'estimate' | 'unavailable';

export interface VoiceTranscriptionRequest {
  audioDataUrl: string;
  mimeType: string;
  durationMs?: number;
  language?: 'en';
}

export interface VoiceTranscriptionChunk {
  text: string;
  timestamp?: [number, number];
}

export interface VoiceTranscriptionTimings {
  asrMs: number;
  cleanupMs: number;
  totalMs: number;
  firstTranscriptMs?: number;
  falMs?: number;
}

export interface VoiceTranscriptionUsage {
  cost?: number;
  costSource?: VoiceTranscriptionCostSource;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface VoiceTranscriptionResult {
  mode: VoiceTranscriptionMode;
  provider: VoiceTranscriptionProvider;
  /** Absent when the host has no OpenRouter key and returned the transcript as heard. */
  cleanupModel?: VoiceTranscriptionCleanupModel;
  text: string;
  rawText: string;
  chunks?: VoiceTranscriptionChunk[];
  languages?: string[];
  timings: VoiceTranscriptionTimings;
  providerUsage?: VoiceTranscriptionUsage;
  cleanupUsage?: VoiceTranscriptionUsage;
}

export interface VoiceDeepgramTokenResult {
  accessToken: string;
  expiresIn: number;
  expiresAt: number;
}

export interface VoiceDeepgramStreamingMetadata {
  requestId?: string;
  duration?: number;
  cost?: number;
  modelName?: string;
  modelVersion?: string;
}

export interface VoiceStreamingFinalizeTimings {
  asrMs?: number;
  firstTranscriptMs?: number;
}

export interface VoiceStreamingFinalizeRequest {
  rawText: string;
  durationMs?: number;
  language?: 'en';
  timings?: VoiceStreamingFinalizeTimings;
  metadata?: VoiceDeepgramStreamingMetadata;
}
