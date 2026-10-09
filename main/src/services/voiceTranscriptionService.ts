import type { ConfigManager } from './configManager';
import type { AnalyticsManager } from './analyticsManager';
import type {
  VoiceDeepgramTokenResult,
  VoiceDeepgramStreamingMetadata,
  VoiceTranscriptionChunk,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
  VoiceTranscriptionUsage,
  VoiceStreamingFinalizeRequest,
} from '../../../shared/types/voiceTranscription';
import {
  boundary,
  decodeBoundary,
  type BoundarySchema,
  type JsonObject,
  type JsonValue,
} from '../../../shared/validation/boundaryDecoder';

const FAL_WIZPER_ENDPOINT = 'https://fal.run/fal-ai/wizper';
const FAL_STORAGE_UPLOAD_INITIATE_ENDPOINT = 'https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';
const OPENROUTER_CHAT_COMPLETIONS_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const DEEPGRAM_AUTH_GRANT_ENDPOINT = 'https://api.deepgram.com/v1/auth/grant';
const CLEANUP_MODEL = 'google/gemini-3.1-flash-lite' as const;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_MS = 15 * 60_000;
const MAX_PROVIDER_ERROR_LENGTH = 400;
const DEEPGRAM_NOVA3_STREAMING_COST_PER_HOUR_USD = 0.462;

const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/mpga',
  'audio/mp3',
  'audio/m4a',
  'audio/x-m4a',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
]);

const ASR_CLEANUP_PROMPT = `# ROLE

You are an automatic-speech-recognition (ASR) post-processor. You receive a raw transcript from a speech-to-text model and return a corrected version. You are NOT an assistant. You do NOT respond, summarize, or help. You have exactly one job: fix obvious ASR errors and return the corrected text. Nothing else.

# ABSOLUTE RULES

- Output ONLY the corrected transcript. No preamble, no explanation, no JSON, no markdown fences, no quotes around the output.
- NEVER add, remove, paraphrase, reorder, or summarize content. Same words, same order, same meaning.
- NEVER respond to the content. If the speaker asks a question, return the question. If the speaker requests code, return the request.
- If the input is empty or unintelligible, return it unchanged.

# WHAT TO FIX

1. Technical terms: restore correct spelling and casing. Treat the glossary below as authoritative.
2. Homophones: pick the version that fits the surrounding context.
3. Filler removal: drop "uh", "um", "uhh", "mm", "hmm", "you know", and "like" when used only as filler.
4. Capitalization: first word of every sentence, "I", proper nouns, brand names.
5. Punctuation: add natural punctuation based on speech rhythm. Do not over-punctuate.
6. Acronyms: uppercase known acronyms including API, SDK, LLM, REST, gRPC, SQL, JSON, YAML, CSV, URL, HTTP, HTTPS, AWS, GCP.
7. Internet slang: lowercase lol, lmao, btw, tbh, idk, imo, ftw.
8. Model names: normalize spoken model labels exactly. "GPT five point five" and "GPT five dot five" are GPT-5.5. "medium high" is medium-high. Do not rewrite GPT-5.5 as GPT-4o, and do not rewrite medium or medium-high as mini.

# WHAT NOT TO TOUCH

- Word choice and phrasing. Preserve exactly as spoken, even if awkward.
- Contractions. Keep them as spoken.
- Style. Do not improve, shorten, or polish the text beyond ASR correction.
- Repetition. Keep intentional repetition.

# GLOSSARY

Kubernetes, Postgres, PostgreSQL, useState, useEffect, useMemo, useCallback, useRef, Next.js, Node.js, TypeScript, JavaScript, Tailwind, shadcn/ui, Supabase, Vercel, Anthropic, Claude, Sonnet, Opus, Haiku, GPT, GPT-5.5, GPT-5.5 low, GPT-5.5 medium, GPT-5.5 medium-high, Gemini, Gemini 3.1 Flash Lite, Composio, n8n, Cursor, Aider, Codex, Doozy, Pane, Dcouple, fal.ai, Wizper, OpenRouter, Groq, gRPC, GraphQL, OAuth, JWT, Redis, MongoDB, ClickHouse, DuckDB, BM25, RAG, embeddings, Cohere, SWE-bench, NIAH, Whisper, Parakeet, Deepgram

# EXAMPLES

Input: "i've been using gpt five point five medium and gpt five point five medium high"
Output: I've been using GPT-5.5 medium and GPT-5.5 medium-high.

Input: "whereas gpt five point five medium specifically is okay"
Output: Whereas GPT-5.5 medium specifically is okay.

# OUTPUT

Return only the corrected transcript. Nothing before it, nothing after it.`;

interface ValidatedAudioInput {
  dataUrl: string;
  mimeType: string;
  byteLength: number;
  audioBuffer: Buffer;
}

interface ValidatedStreamingFinalizeInput {
  rawText: string;
  durationMs?: number;
  language: 'en';
  timings?: {
    asrMs?: number;
    firstTranscriptMs?: number;
  };
  metadata?: VoiceDeepgramStreamingMetadata;
}

const falWizperResponseSchema = boundary.object({
  text: boundary.string,
  chunks: boundary.optional(boundary.array(boundary.json)),
  languages: boundary.optional(boundary.array(boundary.json)),
  usage: boundary.optional(boundary.json),
  cost: boundary.optional(boundary.json),
  metadata: boundary.optional(boundary.json),
  metrics: boundary.optional(boundary.json),
});
const falStorageInitiateResponseSchema = boundary.object({
  file_url: boundary.string,
  upload_url: boundary.string,
});
const openRouterResponseSchema = boundary.object({
  choices: boundary.array(boundary.object({
    message: boundary.object({ content: boundary.string }),
  })),
  usage: boundary.optional(boundary.json),
});
const deepgramGrantResponseSchema = boundary.object({
  access_token: boundary.nonEmptyString,
  expires_in: boundary.optional(boundary.number),
});

interface UsageNumbers {
  cost?: number;
  cost_usd?: number;
  total_cost?: number;
  total_cost_usd?: number;
  upstream_inference_cost?: number;
  upstream_inference_completions_cost?: number;
  prompt_tokens?: number;
  input_tokens?: number;
  completion_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface ProviderUsagePayload {
  usage?: JsonValue;
  cost?: JsonValue;
  metadata?: JsonValue;
  metrics?: JsonValue;
}

const usageKeySchema = boundary.enumeration(
  'cost', 'cost_usd', 'total_cost', 'total_cost_usd',
  'upstream_inference_cost', 'upstream_inference_completions_cost',
  'prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'total_tokens',
);

type ProviderUsage = VoiceTranscriptionUsage;

export class VoiceTranscriptionService {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly analyticsManager?: AnalyticsManager,
  ) {}

  async transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    const input = validateVoiceTranscriptionRequest(request);
    const falApiKey = this.getFalApiKey();
    const openRouterApiKey = this.getOpenRouterApiKey();
    if (!falApiKey) {
      throw new Error('Fal API key is not configured. Add it in Settings under Voice Transcription.');
    }

    const startedAt = Date.now();
    if (this.configManager.isVerbose()) {
      console.log('[VoiceTranscription] Recorded pipeline started');
    }
    const raw = await this.transcribeWithFal(input, request.language ?? 'en', falApiKey);
    const cleanupStartedAt = Date.now();
    const cleanText = await this.cleanIfConfigured(raw.text, openRouterApiKey);
    const completedAt = Date.now();

    const result: VoiceTranscriptionResult = {
      mode: 'recorded',
      provider: 'fal-ai/wizper',
      cleanupModel: cleanText.model,
      text: cleanText.text.trim(),
      rawText: raw.text,
      chunks: raw.chunks,
      languages: raw.languages,
      timings: {
        asrMs: cleanupStartedAt - startedAt,
        cleanupMs: completedAt - cleanupStartedAt,
        totalMs: completedAt - startedAt,
        falMs: cleanupStartedAt - startedAt,
      },
      providerUsage: raw.usage,
      cleanupUsage: cleanText.usage,
    };
    this.trackVoiceTranscriptionUsed({
      input,
      requestedDurationMs: request.durationMs,
      result,
      rawUsage: raw.usage,
      cleanupUsage: cleanText.usage,
    });
    if (this.configManager.isVerbose()) {
      console.log('[VoiceTranscription] Recorded pipeline completed', result.timings);
    }
    return result;
  }

  /** Cleans the transcript through OpenRouter when a key is set; without one, returns it as heard. */
  private async cleanIfConfigured(rawText: string, openRouterApiKey: string | undefined): Promise<{
    text: string;
    usage?: ProviderUsage;
    model?: typeof CLEANUP_MODEL;
  }> {
    if (!openRouterApiKey || rawText.trim().length === 0) return { text: rawText };
    return { ...await this.cleanTranscript(rawText, openRouterApiKey), model: CLEANUP_MODEL };
  }

  async getDeepgramStreamingToken(): Promise<VoiceDeepgramTokenResult> {
    const deepgramApiKey = this.getDeepgramApiKey();
    if (!deepgramApiKey) {
      throw new Error('Deepgram API key is not configured. Add it in Settings under Voice Transcription.');
    }

    const response = await fetch(DEEPGRAM_AUTH_GRANT_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Token ${deepgramApiKey}`,
      },
    });
    const payload = await readProviderJson(response, 'Deepgram token grant failed', deepgramGrantResponseSchema);
    const expiresIn = payload.expires_in !== undefined && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 30;

    return {
      accessToken: payload.access_token,
      expiresIn,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  async finalizeStreaming(request: VoiceStreamingFinalizeRequest): Promise<VoiceTranscriptionResult> {
    const input = validateVoiceStreamingFinalizeRequest(request);
    const openRouterApiKey = this.getOpenRouterApiKey();
    const cleanupStartedAt = Date.now();
    if (this.configManager.isVerbose()) {
      console.log('[VoiceTranscription] Streaming cleanup started', {
        rawTranscriptChars: input.rawText.length,
        asrMs: input.timings?.asrMs,
        firstTranscriptMs: input.timings?.firstTranscriptMs,
      });
    }
    const cleanText = await this.cleanIfConfigured(input.rawText, openRouterApiKey);
    const completedAt = Date.now();
    const cleanupMs = completedAt - cleanupStartedAt;
    const asrMs = Math.max(0, Math.round(input.timings?.asrMs ?? 0));
    const providerUsage = getDeepgramUsage(input.metadata, input.durationMs);

    const result: VoiceTranscriptionResult = {
      mode: 'streaming',
      provider: 'deepgram/nova-3',
      cleanupModel: cleanText.model,
      text: cleanText.text.trim(),
      rawText: input.rawText,
      languages: ['en-US'],
      timings: {
        asrMs,
        cleanupMs,
        totalMs: asrMs + cleanupMs,
        firstTranscriptMs: input.timings?.firstTranscriptMs,
      },
      providerUsage,
      cleanupUsage: cleanText.usage,
    };

    this.trackVoiceTranscriptionUsed({
      requestedDurationMs: input.durationMs,
      result,
      rawUsage: providerUsage,
      cleanupUsage: cleanText.usage,
      deepgramMetadata: input.metadata,
    });
    if (this.configManager.isVerbose()) {
      console.log('[VoiceTranscription] Streaming pipeline completed', result.timings);
    }
    return result;
  }

  private getFalApiKey(): string | undefined {
    return firstNonEmpty(this.configManager.getConfig().falApiKey, process.env.FAL_KEY);
  }

  private getOpenRouterApiKey(): string | undefined {
    return firstNonEmpty(this.configManager.getConfig().openRouterApiKey, process.env.OPENROUTER_API_KEY);
  }

  private getDeepgramApiKey(): string | undefined {
    return firstNonEmpty(this.configManager.getConfig().deepgramApiKey, process.env.DEEPGRAM_API_KEY);
  }

  private async transcribeWithFal(
    input: ValidatedAudioInput,
    language: 'en',
    falApiKey: string,
  ): Promise<{ text: string; chunks?: VoiceTranscriptionChunk[]; languages?: string[]; usage?: ProviderUsage }> {
    const audioUrl = await this.uploadAudioToFalStorage(input, falApiKey);
    const response = await fetch(FAL_WIZPER_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Key ${falApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_url: audioUrl,
        task: 'transcribe',
        language,
        chunk_level: 'segment',
        max_segment_len: 29,
        merge_chunks: true,
        version: '3',
      }),
    });

    const payload = await readProviderJson(response, 'Fal Wizper transcription failed', falWizperResponseSchema);

    return {
      text: payload.text,
      chunks: parseFalChunks(payload.chunks),
      languages: parseStringArray(payload.languages),
      usage: parseProviderUsage(payload),
    };
  }

  private async uploadAudioToFalStorage(input: ValidatedAudioInput, falApiKey: string): Promise<string> {
    const filename = `pane-voice-${Date.now()}.${getAudioFileExtension(input.mimeType)}`;
    const initiateResponse = await fetch(FAL_STORAGE_UPLOAD_INITIATE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Key ${falApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file_name: filename,
        content_type: input.mimeType,
      }),
    });

    const initiatePayload = await readProviderJson(
      initiateResponse,
      'Fal audio upload initialization failed',
      falStorageInitiateResponseSchema,
    );

    const uploadResponse = await fetch(initiatePayload.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': input.mimeType,
      },
      body: new Blob([input.audioBuffer], { type: input.mimeType }),
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Fal audio upload failed: ${truncateProviderError(errorText || `HTTP ${uploadResponse.status}`)}`);
    }

    return initiatePayload.file_url;
  }

  private async cleanTranscript(
    rawTranscript: string,
    openRouterApiKey: string,
  ): Promise<{ text: string; usage?: ProviderUsage }> {
    const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://dcouple.ai',
        'X-Title': 'Pane Voice Transcription',
      },
      body: JSON.stringify({
        model: CLEANUP_MODEL,
        messages: [
          { role: 'system', content: ASR_CLEANUP_PROMPT },
          { role: 'user', content: rawTranscript },
        ],
        temperature: 0,
        reasoning: { enabled: false },
        max_tokens: calculateCleanupMaxTokens(rawTranscript),
      }),
    });

    const payload = await readProviderJson(response, 'OpenRouter transcript cleanup failed', openRouterResponseSchema);
    const content = payload.choices?.[0]?.message?.content;
    if (content === undefined) {
      throw new Error('OpenRouter cleanup response did not include text.');
    }

    return {
      text: content.trim(),
      usage: parseProviderUsage(payload.usage),
    };
  }

  private trackVoiceTranscriptionUsed({
    input,
    requestedDurationMs,
    result,
    rawUsage,
    cleanupUsage,
    deepgramMetadata,
  }: {
    input?: ValidatedAudioInput;
    requestedDurationMs?: number;
    result: VoiceTranscriptionResult;
    rawUsage?: ProviderUsage;
    cleanupUsage?: ProviderUsage;
    deepgramMetadata?: VoiceDeepgramStreamingMetadata;
  }): void {
    if (!this.analyticsManager) {
      return;
    }

    try {
      const totalCost = sumDefinedNumbers(rawUsage?.cost, cleanupUsage?.cost);
      const audioDurationMs = requestedDurationMs !== undefined ? Math.max(0, Math.round(requestedDurationMs)) : undefined;
      const audioSeconds = audioDurationMs !== undefined ? Math.round(audioDurationMs / 100) / 10 : undefined;
      this.analyticsManager.track('voice_transcription_used', {
        mode: result.mode,
        provider: result.provider,
        asr_provider: result.provider,
        cleanup_model: result.cleanupModel,
        language: result.languages?.[0] ?? 'en',
        mime_type: input?.mimeType,
        audio_duration_ms: audioDurationMs,
        audio_seconds: audioSeconds,
        audio_duration_bucket: audioSeconds !== undefined
          ? this.analyticsManager.categorizeDuration(audioSeconds)
          : undefined,
        audio_bytes: input?.byteLength,
        audio_bytes_bucket: input
          ? this.analyticsManager.categorizeNumber(input.byteLength, [
            100 * 1024,
            500 * 1024,
            1024 * 1024,
            5 * 1024 * 1024,
            10 * 1024 * 1024,
          ])
          : undefined,
        raw_transcript_chars: result.rawText.length,
        clean_transcript_chars: result.text.length,
        chunk_count: result.chunks?.length,
        asr_ms: result.timings.asrMs,
        fal_ms: result.timings.falMs,
        deepgram_ms: result.provider === 'deepgram/nova-3' ? result.timings.asrMs : undefined,
        time_to_first_transcript_ms: result.timings.firstTranscriptMs,
        cleanup_ms: result.timings.cleanupMs,
        total_ms: result.timings.totalMs,
        provider_cost: rawUsage?.cost,
        provider_cost_source: rawUsage?.costSource,
        fal_cost: result.provider === 'fal-ai/wizper' ? rawUsage?.cost : undefined,
        deepgram_cost: result.provider === 'deepgram/nova-3' ? rawUsage?.cost : undefined,
        deepgram_cost_source: result.provider === 'deepgram/nova-3' ? rawUsage?.costSource : undefined,
        deepgram_request_id: deepgramMetadata?.requestId,
        deepgram_duration_seconds: deepgramMetadata?.duration,
        deepgram_model_name: deepgramMetadata?.modelName,
        deepgram_model_version: deepgramMetadata?.modelVersion,
        openrouter_cost: cleanupUsage?.cost,
        total_cost: totalCost,
        openrouter_prompt_tokens: cleanupUsage?.inputTokens,
        openrouter_completion_tokens: cleanupUsage?.outputTokens,
        openrouter_total_tokens: cleanupUsage?.totalTokens,
      });
    } catch (error) {
      if (this.configManager.isVerbose()) {
        console.warn('[VoiceTranscription] Failed to track analytics event:', error);
      }
    }
  }
}

function validateVoiceTranscriptionRequest(request: VoiceTranscriptionRequest): ValidatedAudioInput {
  if (request.audioDataUrl.trim().length === 0) {
    throw new Error('Voice transcription audio data is required.');
  }

  if (request.mimeType.trim().length === 0) {
    throw new Error('Voice transcription audio MIME type is required.');
  }

  if (request.durationMs !== undefined && request.durationMs > MAX_AUDIO_DURATION_MS + 1_000) {
    throw new Error('Recording is too long. Keep voice clips under 15 minutes.');
  }

  if (request.language !== undefined && request.language !== 'en') {
    throw new Error('Voice transcription currently supports English only.');
  }

  const match = request.audioDataUrl.match(/^data:([^,]+);base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) {
    throw new Error('Voice transcription audio must be a base64 data URL.');
  }

  const dataUrlMimeType = normalizeMimeType(match[1]);
  const declaredMimeType = normalizeMimeType(request.mimeType);
  if (!SUPPORTED_AUDIO_MIME_TYPES.has(dataUrlMimeType) || !SUPPORTED_AUDIO_MIME_TYPES.has(declaredMimeType)) {
    throw new Error('Unsupported voice recording format. Use WebM, MP4, MP3, M4A, or WAV audio.');
  }

  const base64Payload = match[2].replace(/\s/g, '');
  const audioBuffer = Buffer.from(base64Payload, 'base64');
  const byteLength = audioBuffer.byteLength;
  if (byteLength === 0) {
    throw new Error('Voice recording was empty.');
  }
  if (byteLength > MAX_AUDIO_BYTES) {
    throw new Error('Recording is too large. Keep voice clips under 10 MB.');
  }

  return {
    dataUrl: `data:${dataUrlMimeType};base64,${base64Payload}`,
    mimeType: dataUrlMimeType,
    byteLength,
    audioBuffer,
  };
}

function validateVoiceStreamingFinalizeRequest(request: VoiceStreamingFinalizeRequest): ValidatedStreamingFinalizeInput {
  if (request.durationMs !== undefined && request.durationMs > MAX_AUDIO_DURATION_MS + 5_000) {
    throw new Error('Streaming recording is too long. Keep voice clips under 15 minutes.');
  }
  if (request.language !== undefined && request.language !== 'en') {
    throw new Error('Voice transcription currently supports English only.');
  }

  return {
    rawText: request.rawText,
    durationMs: request.durationMs !== undefined
      ? Math.max(0, Math.round(request.durationMs))
      : undefined,
    language: request.language ?? 'en',
    timings: normalizeStreamingTimings(request.timings),
    metadata: normalizeDeepgramMetadata(request.metadata),
  };
}

function normalizeStreamingTimings(timings: VoiceStreamingFinalizeRequest['timings']): ValidatedStreamingFinalizeInput['timings'] {
  if (!timings) {
    return undefined;
  }

  const normalized = {
    asrMs: normalizeOptionalMs(timings.asrMs),
    firstTranscriptMs: normalizeOptionalMs(timings.firstTranscriptMs),
  };
  return normalized.asrMs !== undefined || normalized.firstTranscriptMs !== undefined
    ? normalized
    : undefined;
}

function normalizeOptionalMs(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : undefined;
}

function normalizeDeepgramMetadata(metadata: VoiceStreamingFinalizeRequest['metadata']): VoiceDeepgramStreamingMetadata | undefined {
  if (!metadata) {
    return undefined;
  }

  return {
    requestId: metadata.requestId,
    duration: metadata.duration !== undefined && Number.isFinite(metadata.duration) ? metadata.duration : undefined,
    cost: metadata.cost !== undefined && Number.isFinite(metadata.cost) ? metadata.cost : undefined,
    modelName: metadata.modelName,
    modelVersion: metadata.modelVersion,
  };
}

async function readProviderJson<Value>(
  response: Response,
  fallbackMessage: string,
  schema: BoundarySchema<Value>,
): Promise<Value> {
  let payload: JsonValue = null;
  const text = await response.text();
  if (text.trim().length > 0) {
    try {
      payload = decodeBoundary(JSON.parse(text), boundary.json);
    } catch {
      if (!response.ok) {
        throw new Error(`${fallbackMessage}: HTTP ${response.status}`);
      }
      throw new Error(`${fallbackMessage}: invalid JSON response.`);
    }
  }

  if (!response.ok) {
    throw new Error(`${fallbackMessage}: ${extractProviderMessage(payload) ?? `HTTP ${response.status}`}`);
  }

  try {
    return decodeBoundary(payload ?? {}, schema);
  } catch {
    throw new Error(`${fallbackMessage}: invalid response shape.`);
  }
}

function extractProviderMessage(payload: JsonValue): string | null {
  if (payload === null || Array.isArray(payload)) {
    return null;
  }
  let record: JsonObject;
  try {
    record = decodeBoundary(payload, boundary.jsonObject);
  } catch {
    return null;
  }
  const candidates = [
    record.message,
    record.error,
    record.detail,
  ];

  for (const candidate of candidates) {
    const message = decodeOptionalBoundary(candidate, boundary.string);
    if (message?.trim()) return truncateProviderError(message.trim());
    const nested = decodeOptionalBoundary(candidate, boundary.object({ message: boundary.string }));
    if (nested?.message.trim()) return truncateProviderError(nested.message.trim());
  }

  return truncateProviderError(JSON.stringify(payload));
}

function truncateProviderError(message: string): string {
  return message.length > MAX_PROVIDER_ERROR_LENGTH
    ? `${message.slice(0, MAX_PROVIDER_ERROR_LENGTH)}...`
    : message;
}

function parseFalChunks(value: JsonValue[] | undefined): VoiceTranscriptionChunk[] | undefined {
  if (!value) return undefined;
  const chunks: VoiceTranscriptionChunk[] = [];
  for (const item of value) {
    const record = decodeOptionalBoundary(item, boundary.object({
      text: boundary.string,
      timestamp: boundary.optional(boundary.json),
    }));
    if (!record) continue;
    const timestamp = parseTimestamp(record.timestamp);
    chunks.push(timestamp ? { text: record.text, timestamp } : { text: record.text });
  }

  return chunks.length > 0 ? chunks : undefined;
}

function parseTimestamp(value: JsonValue | undefined): [number, number] | undefined {
  const decoded = decodeOptionalBoundary(value, boundary.array(boundary.number));
  return decoded?.length === 2 ? [decoded[0], decoded[1]] : undefined;
}

function parseStringArray(value: JsonValue[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const values = value.flatMap((item) => {
    const decoded = decodeOptionalBoundary(item, boundary.string);
    return decoded === undefined ? [] : [decoded];
  });
  return values.length > 0 ? values : undefined;
}

function parseProviderUsage(value: JsonValue | VoiceDeepgramStreamingMetadata | ProviderUsagePayload | undefined): ProviderUsage | undefined {
  const values = collectUsageNumbers(value);
  const usage: ProviderUsage = {
    cost: firstDefinedNumber(
      values.cost,
      values.cost_usd,
      values.total_cost,
      values.total_cost_usd,
      values.upstream_inference_cost,
      values.upstream_inference_completions_cost,
    ),
    inputTokens: firstDefinedNumber(values.prompt_tokens, values.input_tokens),
    outputTokens: firstDefinedNumber(values.completion_tokens, values.output_tokens),
    totalTokens: firstDefinedNumber(values.total_tokens),
  };
  if (usage.cost !== undefined) {
    usage.costSource = 'provider';
  }

  return Object.values(usage).some(item => item !== undefined) ? usage : undefined;
}

function getDeepgramUsage(
  metadata: VoiceDeepgramStreamingMetadata | undefined,
  durationMs: number | undefined,
): ProviderUsage {
  const metadataUsage = parseProviderUsage(metadata);
  if (metadataUsage?.cost !== undefined) {
    return {
      ...metadataUsage,
      costSource: 'metadata',
    };
  }

  const durationSeconds = durationMs !== undefined
    ? durationMs / 1000
    : metadata?.duration;
  if (durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    return {
      cost: Number(((durationSeconds / 3600) * DEEPGRAM_NOVA3_STREAMING_COST_PER_HOUR_USD).toFixed(8)),
      costSource: 'estimate',
    };
  }

  return {
    costSource: 'unavailable',
  };
}

function collectUsageNumbers(value: JsonValue | VoiceDeepgramStreamingMetadata | ProviderUsagePayload | undefined): UsageNumbers {
  const jsonValue = value === undefined ? undefined : decodeOptionalBoundary(value, boundary.json);
  const numbers: UsageNumbers = {};
  if (jsonValue === undefined) return numbers;
  const visit = (candidate: JsonValue): void => {
    const record = decodeOptionalBoundary(candidate, boundary.jsonObject);
    if (!record) return;
    for (const key of Object.keys(record)) {
      const nestedValue = record[key];
      const numeric = decodeUsageNumber(nestedValue);
      const usageKey = decodeOptionalBoundary(key, usageKeySchema);
      if (usageKey !== undefined && numeric !== undefined) numbers[usageKey] ??= numeric;
      if (['usage', 'cost', 'metadata', 'metrics'].includes(key)) visit(nestedValue);
    }
  };
  visit(jsonValue);
  return numbers;
}

function decodeUsageNumber(value: JsonValue): number | undefined {
  const numeric = decodeOptionalBoundary(value, boundary.number);
  if (numeric !== undefined && Number.isFinite(numeric)) return numeric;
  const text = decodeOptionalBoundary(value, boundary.string)?.trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decodeOptionalBoundary<Value>(
  value: JsonValue | VoiceDeepgramStreamingMetadata | ProviderUsagePayload | undefined,
  schema: BoundarySchema<Value>,
): Value | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeBoundary(value, schema);
  } catch {
    return undefined;
  }
}

function firstDefinedNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value): value is number => value !== undefined && Number.isFinite(value));
}

function sumDefinedNumbers(...values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (numbers.length === 0) {
    return undefined;
  }
  return Number(numbers.reduce((sum, value) => sum + value, 0).toFixed(8));
}

function calculateCleanupMaxTokens(rawTranscript: string): number {
  return Math.min(8_192, Math.max(128, Math.ceil(rawTranscript.length / 2) + 256));
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
}

function getAudioFileExtension(mimeType: string): string {
  switch (mimeType) {
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/mpeg':
    case 'audio/mpga':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/webm':
    default:
      return 'webm';
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}
