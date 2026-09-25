import { describe, expect, it } from 'vitest';
import { parseDeepgramLiveMessage, readResultsMetadata } from '../../../../shared/voice/deepgramLive';

describe('Deepgram live message decoding', () => {
  it('decodes transcript, metadata, and error messages', () => {
    expect(parseDeepgramLiveMessage(JSON.stringify({
      type: 'Results',
      is_final: true,
      speech_final: false,
      channel: { alternatives: [{ transcript: '  hello Pane  ' }] },
    }))).toEqual({
      type: 'transcript',
      update: { transcript: 'hello Pane', isFinal: true, speechFinal: false },
    });
    expect(parseDeepgramLiveMessage(JSON.stringify({
      type: 'Metadata',
      request_id: 'request-1',
      duration: 1.25,
    }))).toEqual({
      type: 'metadata',
      metadata: { requestId: 'request-1', duration: 1.25 },
    });
    expect(parseDeepgramLiveMessage(JSON.stringify({
      type: 'Error',
      message: '  unavailable  ',
    }))).toEqual({ type: 'error', message: 'unavailable' });
  });

  it('rejects malformed messages without leaking partial values', () => {
    expect(parseDeepgramLiveMessage('{')).toEqual({ type: 'other' });
    expect(parseDeepgramLiveMessage(JSON.stringify({
      type: 'Results',
      channel: { alternatives: [{ transcript: 42 }] },
    }))).toEqual({ type: 'other' });
    expect(readResultsMetadata(JSON.stringify({ metadata: { request_id: 42 } }))).toBeUndefined();
  });

  it('decodes result metadata', () => {
    expect(readResultsMetadata(JSON.stringify({
      metadata: {
        request_id: 'request-2',
        model_info: { name: 'nova-3', version: '2026-08' },
      },
    }))).toEqual({
      requestId: 'request-2',
      modelName: 'nova-3',
      modelVersion: '2026-08',
    });
  });
});
