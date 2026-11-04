import type { VoiceDeepgramStreamingMetadata } from '../types/voiceTranscription';
import {
  boundary,
  decodeOptionalBoundary,
} from '../validation/boundaryDecoder';

const DEEPGRAM_STREAMING_KEYTERMS = [
  'Doozy',
  'Pane',
  'Dcouple',
  'Composio',
  'Anthropic',
  'Claude',
  'Claude Opus',
  'Claude Sonnet',
  'GPT',
  'GPT-5.5',
  'GPT-5.5 medium',
  'GPT-5.5 medium-high',
  'Gemini',
  'Gemini 3.1 Flash Lite',
  'Postgres',
  'PostgreSQL',
  'Supabase',
  'Next.js',
  'TypeScript',
  'JavaScript',
  'useState',
  'useEffect',
  'useMemo',
  'useCallback',
  'gRPC',
  'GraphQL',
  'OAuth',
  'JWT',
  'Kubernetes',
  'Cursor',
  'Aider',
  'Codex',
  'OpenRouter',
  'RAG',
  'embeddings',
  'BM25',
  'SWE-bench',
  'n8n',
  'Tailwind',
  'shadcn/ui',
];

interface DeepgramTranscriptUpdate {
  transcript: string;
  isFinal: boolean;
  speechFinal: boolean;
}

/**
 * Why a Pane host ended a voice stream, sent as `code` on its Error frame: the saved key can't be
 * one, Deepgram refused the key, or Deepgram failed otherwise. Deepgram's own Error frames have none.
 */
export type VoiceStreamErrorCode = 'ERR_VOICE_KEY_INVALID' | 'ERR_VOICE_KEY_REJECTED' | 'ERR_VOICE_UPSTREAM';

export type DeepgramLiveMessage =
  | { type: 'transcript'; update: DeepgramTranscriptUpdate }
  | { type: 'metadata'; metadata: VoiceDeepgramStreamingMetadata }
  | { type: 'error'; message: string; code?: VoiceStreamErrorCode }
  | { type: 'other' };

const transcriptMessageSchema = boundary.object({
  type: boundary.literal('Results'),
  is_final: boundary.optional(boundary.boolean),
  speech_final: boundary.optional(boundary.boolean),
  channel: boundary.object({
    alternatives: boundary.array(boundary.object({ transcript: boundary.string })),
  }),
});

const metadataMessageSchema = boundary.object({
  type: boundary.literal('Metadata'),
  request_id: boundary.optional(boundary.string),
  duration: boundary.optional(boundary.number),
});

const errorMessageSchema = boundary.object({
  type: boundary.literal('Error'),
  message: boundary.optional(boundary.string),
  code: boundary.optional(boundary.string),
});

const VOICE_STREAM_ERROR_CODES: ReadonlySet<string> = new Set<VoiceStreamErrorCode>(['ERR_VOICE_KEY_INVALID', 'ERR_VOICE_KEY_REJECTED', 'ERR_VOICE_UPSTREAM']);

function isVoiceStreamErrorCode(code: string | undefined): code is VoiceStreamErrorCode {
  return code !== undefined && VOICE_STREAM_ERROR_CODES.has(code);
}

const resultsMetadataSchema = boundary.object({
  metadata: boundary.object({
    request_id: boundary.optional(boundary.string),
    model_info: boundary.optional(boundary.object({
      name: boundary.optional(boundary.string),
      version: boundary.optional(boundary.string),
    })),
  }),
});

export function buildDeepgramListenUrl(keyterms = DEEPGRAM_STREAMING_KEYTERMS): string {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-3');
  url.searchParams.set('language', 'en-US');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('endpointing', '300');
  url.searchParams.set('vad_events', 'true');
  url.searchParams.set('tag', 'pane-pwa-voice');
  for (const term of keyterms) {
    url.searchParams.append('keyterm', term);
  }
  return url.toString();
}

export function parseDeepgramLiveMessage(data: string): DeepgramLiveMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { type: 'other' };
  }

  const transcriptMessage = decodeOptionalBoundary(parsed, transcriptMessageSchema);
  if (transcriptMessage) {
    const transcript = transcriptMessage.channel.alternatives[0]?.transcript.trim();
    if (!transcript) return { type: 'other' };
    return {
      type: 'transcript',
      update: {
        transcript,
        isFinal: transcriptMessage.is_final === true,
        speechFinal: transcriptMessage.speech_final === true,
      },
    };
  }

  const metadataMessage = decodeOptionalBoundary(parsed, metadataMessageSchema);
  if (metadataMessage) {
    return {
      type: 'metadata',
      metadata: {
        requestId: metadataMessage.request_id,
        duration: metadataMessage.duration,
      },
    };
  }

  const errorMessage = decodeOptionalBoundary(parsed, errorMessageSchema);
  if (errorMessage) {
    const message = errorMessage.message?.trim()
      ? errorMessage.message.trim()
      : 'Deepgram live transcription failed.';
    return isVoiceStreamErrorCode(errorMessage.code) ? { type: 'error', message, code: errorMessage.code } : { type: 'error', message };
  }

  return { type: 'other' };
}

export function readResultsMetadata(data: string): VoiceDeepgramStreamingMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  const result = decodeOptionalBoundary(parsed, resultsMetadataSchema);
  if (!result) return undefined;
  const { metadata } = result;
  return {
    requestId: metadata.request_id,
    modelName: metadata.model_info?.name,
    modelVersion: metadata.model_info?.version,
  };
}
