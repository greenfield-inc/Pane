import type { VoiceDeepgramStreamingMetadata } from '@shared/types/voiceTranscription';
import { parseDeepgramLiveMessage, readResultsMetadata } from '@shared/voice/deepgramLive';

/** The host's WebSocket that proxies live audio to Deepgram. */
export function voiceStreamUrl(baseUrl: string): string {
  const url = new URL('/voice/deepgram-stream', baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * A WAV header for an open-ended 16-bit mono PCM stream. Deepgram reads the
 * format from it, so raw microphone samples can follow with no other setup.
 */
export function wavStreamHeader(sampleRate: number): ArrayBuffer {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) header.setUint8(offset + index, value.charCodeAt(index));
  };
  const unknownLength = 0xffffffff;
  text(0, 'RIFF');
  header.setUint32(4, unknownLength, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true); // fmt chunk size
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true); // byte rate
  header.setUint16(32, 2, true); // block align
  header.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  header.setUint32(40, unknownLength, true);
  return header.buffer;
}

/** Collects Deepgram's live results into the text shown while speaking and the text sent for cleanup. */
export class LiveTranscript {
  private finals: string[] = [];
  private interim = '';
  metadata: VoiceDeepgramStreamingMetadata | undefined;
  firstTranscriptMs: number | undefined;

  constructor(private readonly startedAt: number) {}

  /** Returns an error message when Deepgram reports one. */
  receive(data: string, now: number): string | null {
    const resultsMetadata = readResultsMetadata(data);
    if (resultsMetadata) this.metadata = { ...this.metadata, ...definedOnly(resultsMetadata) };
    const message = parseDeepgramLiveMessage(data);
    switch (message.type) {
      case 'metadata':
        this.metadata = { ...this.metadata, ...definedOnly(message.metadata) };
        return null;
      case 'error':
        return message.message;
      case 'transcript':
        this.firstTranscriptMs ??= Math.max(0, Math.round(now - this.startedAt));
        if (message.update.isFinal) {
          this.finals.push(message.update.transcript);
          this.interim = '';
        } else {
          this.interim = message.update.transcript;
        }
        return null;
      default:
        return null;
    }
  }

  /** Everything heard so far, including words Deepgram may still revise. */
  get preview(): string {
    return [...this.finals, this.interim].filter(Boolean).join(' ');
  }

  /** Final text, or the last interim result when nothing was finalized. */
  get rawText(): string {
    return this.finals.join(' ').trim() || this.interim.trim();
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
