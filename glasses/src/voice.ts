// Dictation through a Pane computer, as the Pane phone app does it
// (native/src/features/voice/useVoiceDictation.ts): with a Deepgram key the glasses' PCM streams
// over the host's /voice/deepgram-stream WebSocket and voice:finalize-streaming cleans it up;
// otherwise the PCM is wrapped as WAV on release and sent to voice:transcribe.
import type { VoiceTranscriptionMode } from '../../shared/types/voiceTranscription';
import { parseDeepgramLiveMessage, type VoiceStreamErrorCode } from '../../shared/voice/deepgramLive';
import { GLASSES_WEBSOCKET_PROTOCOL } from '../../shared/types/glasses';
import { GlassesError, type Dictation } from './model';

const SAMPLE_RATE = 16_000;
const OPEN_TIMEOUT_MS = 8_000;
/** Time for Deepgram to return the last words after `Finalize`. */
const FINALIZE_WAIT_MS = 800;

/** The voice setup a host reports in `remote:pwa-affordances`. */
export interface HostVoice {
  availableModes: VoiceTranscriptionMode[];
  defaultMode: VoiceTranscriptionMode;
}

/** The mode the host can record in, or null when it has no speech key. */
export function voiceMode(voice: HostVoice): VoiceTranscriptionMode | null {
  return voice.availableModes.includes(voice.defaultMode) ? voice.defaultMode : voice.availableModes[0] ?? null;
}

/** The host's voice WebSocket URL under its base URL. Never carries a credential. */
export function voiceStreamUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/voice/deepgram-stream`;
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function writeWavHeader(view: DataView, sampleRate: number, dataBytes: number): void {
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, dataBytes === 0xffffffff ? dataBytes : 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
}

/** A WAV header for an open-ended 16-bit mono stream; Deepgram reads the format from it. */
function wavStreamHeader(sampleRate = SAMPLE_RATE): ArrayBuffer {
  const buffer = new ArrayBuffer(44);
  writeWavHeader(new DataView(buffer), sampleRate, 0xffffffff);
  return buffer;
}

/** A complete WAV file of 16-bit mono PCM chunks. */
export function wavFile(chunks: readonly Uint8Array[], sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(44 + dataBytes);
  writeWavHeader(new DataView(out.buffer), sampleRate, dataBytes);
  let offset = 44;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** The part of a WebSocket a dictation uses. */
export interface VoiceSocket {
  readyState: number;
  binaryType: BinaryType;
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(): void;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string | ArrayBuffer>) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}

/** What a dictation needs from its computer. */
export interface VoiceHost {
  /** The computer's name, as the glasses show it. */
  name: string;
  baseUrl: string;
  token: string;
  finalizeStreaming(rawText: string, durationMs: number): Promise<string>;
  transcribe(audioDataUrl: string, durationMs: number): Promise<string>;
  now(): number;
  openSocket(url: string, protocols: string[]): VoiceSocket;
}

/** Collects Deepgram's live results into the words shown while speaking and the text sent for cleanup. */
class LiveTranscript {
  private finals: string[] = [];
  private interim = '';
  error: { message: string; code?: VoiceStreamErrorCode } | null = null;

  receive(data: string): void {
    const message = parseDeepgramLiveMessage(data);
    if (message.type === 'error') this.error = { message: message.message, code: message.code };
    if (message.type !== 'transcript') return;
    if (message.update.isFinal) {
      this.finals.push(message.update.transcript);
      this.interim = '';
    } else this.interim = message.update.transcript;
  }

  get preview(): string {
    return [...this.finals, this.interim].filter(Boolean).join(' ');
  }

  get rawText(): string {
    return this.finals.join(' ').trim() || this.interim.trim();
  }
}

function openStream(host: VoiceHost, onText: (data: string) => void): Promise<VoiceSocket> {
  return new Promise((resolve, reject) => {
    const ws = host.openSocket(voiceStreamUrl(host.baseUrl), [GLASSES_WEBSOCKET_PROTOCOL, host.token]);
    ws.binaryType = 'arraybuffer';
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('The voice service on this computer did not answer.'));
    }, OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timeout);
      ws.send(wavStreamHeader());
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Couldn't reach the voice service on this computer."));
    };
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) return;
      onText(event.data);
    };
  });
}

const VOICE_SETTINGS = 'Settings › Integrations › Voice transcription';

/**
 * What the glasses show when a stream fails: the host's reason when it sent one, naming the
 * computer and the fix, or a dropped connection when it sent none.
 */
function streamFailure(name: string, error: LiveTranscript['error']): GlassesError {
  switch (error?.code) {
    case 'ERR_VOICE_KEY_INVALID':
      return new GlassesError(error.code, `${name}'s Deepgram key isn't a valid key.`, `Paste the key again in Pane on ${name}: ${VOICE_SETTINGS}.`);
    case 'ERR_VOICE_KEY_REJECTED':
      return new GlassesError(error.code, `Deepgram rejected ${name}'s key.`, `Fix it in Pane on ${name}: ${VOICE_SETTINGS}.`);
    case 'ERR_VOICE_UPSTREAM':
      return new GlassesError(error.code, `${name} couldn't stream to Deepgram. ${error.message}`, 'Hold to talk again.');
    case undefined:
      return error
        ? new GlassesError('ERR_GLASSES_VOICE_FAILED', `Deepgram stopped listening on ${name}: ${error.message}`, 'Hold to talk again.')
        : new GlassesError('ERR_GLASSES_VOICE_DROPPED', `Lost the connection to ${name} while listening.`, 'Hold to talk again.');
  }
}

/** Live words over the host's Deepgram stream while you hold. */
export async function streamingDictation(host: VoiceHost, onPreview: (text: string) => void): Promise<Dictation> {
  const startedAt = host.now();
  const live = new LiveTranscript();
  const ws = await openStream(host, (data) => {
    live.receive(data);
    onPreview(live.preview);
  });
  // Closing after CloseStream, or cancelling, marks the close as ours; any other close or
  // error means the host or Deepgram gave up and the words so far are incomplete.
  let ending = false;
  let dropped = false;
  ws.onclose = ws.onerror = () => {
    if (!ending) dropped = true;
  };
  return {
    push(pcm) {
      // A copy, so the frame is backed by a plain ArrayBuffer.
      if (!dropped && ws.readyState === WebSocket.OPEN) ws.send(new Uint8Array(pcm));
    },
    async finish() {
      if (!dropped && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'Finalize' }));
        await new Promise((resolve) => setTimeout(resolve, FINALIZE_WAIT_MS));
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
      // A drop up to here, Finalize's wait included, loses words: nothing is sent.
      ending = true;
      ws.close();
      if (dropped || (live.error && !live.rawText)) throw streamFailure(host.name, live.error);
      return live.rawText ? host.finalizeStreaming(live.rawText, host.now() - startedAt) : '';
    },
    cancel() {
      ending = true;
      ws.close();
    },
  };
}

/** Buffers the glasses' PCM and sends it as one WAV clip on release. */
export function recordedDictation(host: VoiceHost, onPreview: (text: string) => void): Dictation {
  const startedAt = host.now();
  let chunks: Uint8Array[] = [];
  onPreview('Recording… release to send');
  return {
    push(pcm) {
      chunks.push(pcm);
    },
    async finish() {
      if (!chunks.length) return '';
      const wav = wavFile(chunks);
      chunks = [];
      return host.transcribe(`data:audio/wav;base64,${base64(wav)}`, host.now() - startedAt);
    },
    cancel() {
      chunks = [];
    },
  };
}
