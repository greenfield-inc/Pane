import { describe, expect, it } from 'vitest';

import { LiveTranscript, voiceStreamUrl, wavStreamHeader } from './liveTranscript';

const results = (transcript: string, isFinal: boolean) => JSON.stringify({
  type: 'Results',
  is_final: isFinal,
  channel: { alternatives: [{ transcript }] },
  metadata: { request_id: 'req-1', model_info: { name: 'nova-3', version: '2026-01' } },
});

describe('voiceStreamUrl', () => {
  it('uses the matching WebSocket scheme and carries no token', () => {
    expect(voiceStreamUrl('http://127.0.0.1:42157')).toBe('ws://127.0.0.1:42157/voice/deepgram-stream');
    expect(voiceStreamUrl('https://mac.tail1234.ts.net/')).toBe('wss://mac.tail1234.ts.net/voice/deepgram-stream');
  });
});

describe('wavStreamHeader', () => {
  it('describes 16-bit mono PCM at the given rate', () => {
    const header = new DataView(wavStreamHeader(16_000));
    const ascii = (offset: number) => String.fromCharCode(...new Uint8Array(header.buffer, offset, 4));
    expect(header.byteLength).toBe(44);
    expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    expect(header.getUint16(20, true)).toBe(1); // PCM
    expect(header.getUint16(22, true)).toBe(1); // channels
    expect(header.getUint32(24, true)).toBe(16_000);
    expect(header.getUint32(28, true)).toBe(32_000);
    expect(header.getUint16(34, true)).toBe(16);
  });
});

describe('LiveTranscript', () => {
  it('previews interim words and keeps only finalized text for cleanup', () => {
    const transcript = new LiveTranscript(1_000);
    transcript.receive(results('fix the', false), 1_400);
    expect(transcript.preview).toBe('fix the');
    transcript.receive(results('fix the login bug', true), 1_900);
    transcript.receive(results('and add', false), 2_300);

    expect(transcript.preview).toBe('fix the login bug and add');
    expect(transcript.rawText).toBe('fix the login bug');
    expect(transcript.firstTranscriptMs).toBe(400);
    expect(transcript.metadata).toEqual({ requestId: 'req-1', modelName: 'nova-3', modelVersion: '2026-01' });
  });

  it('falls back to the interim text when nothing was finalized', () => {
    const transcript = new LiveTranscript(0);
    transcript.receive(results('hello there', false), 10);
    expect(transcript.rawText).toBe('hello there');
  });

  it('reports Deepgram errors', () => {
    const transcript = new LiveTranscript(0);
    expect(transcript.receive(JSON.stringify({ type: 'Error', message: 'Bad audio' }), 0)).toBe('Bad audio');
  });
});
