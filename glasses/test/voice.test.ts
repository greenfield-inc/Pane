import { describe, expect, it } from 'vitest';
import { recordedDictation, streamingDictation, voiceMode, voiceStreamUrl, wavFile, type VoiceHost } from '../src/voice';

const message = (data: string) => new MessageEvent<string | ArrayBuffer>('message', { data });

/** A WebSocket that opens at once and records what the dictation sends. */
class FakeSocket {
  static readonly OPEN = 1;
  readyState = 1;
  binaryType: BinaryType = 'blob';
  sent: Array<string | Uint8Array | ArrayBuffer> = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string | ArrayBuffer>) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string, readonly protocols: string[]) {
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  send(data: string | Uint8Array | ArrayBuffer) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

function voiceHost(sockets: FakeSocket[], calls: string[]): VoiceHost {
  return {
    name: 'devbox',
    baseUrl: 'https://studio.tail1.ts.net:8443',
    token: 'pgt_secret',
    now: () => 1_000,
    openSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    finalizeStreaming: async (rawText) => {
      calls.push(`finalize:${rawText}`);
      return 'Stub the clock.';
    },
    transcribe: async (audioDataUrl) => {
      calls.push(audioDataUrl.slice(0, 22));
      return 'Loosen retry.';
    },
  };
}

describe('voice', () => {
  it("records in the host's default mode when it can, else the one it has, else not at all", () => {
    expect(voiceMode({ availableModes: ['recorded', 'streaming'], defaultMode: 'streaming' })).toBe('streaming');
    expect(voiceMode({ availableModes: ['recorded'], defaultMode: 'streaming' })).toBe('recorded');
    expect(voiceMode({ availableModes: [], defaultMode: 'streaming' })).toBeNull();
  });

  it('opens the voice stream with no credential in the URL', () => {
    expect(voiceStreamUrl('https://studio.tail1.ts.net:8443')).toBe('wss://studio.tail1.ts.net:8443/voice/deepgram-stream');
  });

  it('wraps 16 kHz mono PCM as a WAV file', () => {
    const wav = wavFile([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    const view = new DataView(wav.buffer);
    const ascii = (from: number) => String.fromCharCode(...wav.slice(from, from + 4));
    expect([ascii(0), view.getUint32(4, true), ascii(8), ascii(12), ascii(36), view.getUint32(40, true)]).toEqual(['RIFF', 40, 'WAVE', 'fmt ', 'data', 4]);
    expect([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint32(28, true), view.getUint16(34, true)]).toEqual([1, 1, 16_000, 32_000, 16]);
    expect([...wav.slice(44)]).toEqual([1, 2, 3, 4]);
  });

  it('streams PCM with the token in the subprotocol, shows words live, and finalizes on release', async () => {
    const sockets: FakeSocket[] = [];
    const calls: string[] = [];
    const previews: string[] = [];
    const dictation = await streamingDictation(voiceHost(sockets, calls), (text) => previews.push(text));
    const [ws] = sockets;
    if (!ws) throw new Error('no socket');
    expect(ws.url).toBe('wss://studio.tail1.ts.net:8443/voice/deepgram-stream');
    expect(ws.protocols).toEqual(['pane-glasses', 'pgt_secret']);
    dictation.push(new Uint8Array([9, 9]));
    ws.onmessage?.(message(JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'stub the' }] } })));
    ws.onmessage?.(message(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'stub the clock' }] } })));
    expect(previews).toEqual(['stub the', 'stub the clock']);
    expect(await dictation.finish()).toBe('Stub the clock.');
    expect(calls).toEqual(['finalize:stub the clock']);
    expect(ws.sent[0]).toBeInstanceOf(ArrayBuffer);
    expect(ws.sent[1]).toEqual(new Uint8Array([9, 9]));
    expect(ws.sent.slice(2)).toEqual([JSON.stringify({ type: 'Finalize' }), JSON.stringify({ type: 'CloseStream' })]);
    expect(ws.closed).toBe(true);
  });

  it('fails a stream the connection dropped instead of sending the words heard before', async () => {
    const sockets: FakeSocket[] = [];
    const calls: string[] = [];
    const dictation = await streamingDictation(voiceHost(sockets, calls), () => {});
    const [ws] = sockets;
    if (!ws) throw new Error('no socket');
    ws.onmessage?.(message(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'run the deployment' }] } })));
    ws.readyState = 3;
    ws.onclose?.();
    dictation.push(new Uint8Array([7]));
    await expect(dictation.finish()).rejects.toMatchObject({ code: 'ERR_GLASSES_VOICE_DROPPED', message: 'Lost the connection to devbox while listening.' });
    expect(calls).toEqual([]);
  });

  it("names the computer and the fix when the host says Deepgram refused its key", async () => {
    const sockets: FakeSocket[] = [];
    const dictation = await streamingDictation(voiceHost(sockets, []), () => {});
    const [ws] = sockets;
    if (!ws) throw new Error('no socket');
    ws.onmessage?.(message(JSON.stringify({ type: 'Error', code: 'ERR_VOICE_KEY_REJECTED', message: 'Deepgram rejected the key saved on this computer (HTTP 401).' })));
    ws.readyState = 3;
    ws.onclose?.();
    await expect(dictation.finish()).rejects.toMatchObject({
      code: 'ERR_VOICE_KEY_REJECTED',
      message: "Deepgram rejected devbox's key.",
      next: 'Fix it in Pane on devbox: Settings › Integrations › Voice transcription.',
    });
  });

  it('sends a recorded clip as one WAV on release when the host has no Deepgram key', async () => {
    const calls: string[] = [];
    const dictation = recordedDictation(voiceHost([], calls), () => {});
    dictation.push(new Uint8Array([1, 2]));
    expect(await dictation.finish()).toBe('Loosen retry.');
    expect(calls).toEqual(['data:audio/wav;base64,']);
  });
});
