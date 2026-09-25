import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioStream,
} from 'expo-audio';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { RemotePwaAffordances } from '@shared/types/remoteDaemon';
import type {
  VoiceStreamingFinalizeRequest,
  VoiceTranscriptionMode,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from '@shared/types/voiceTranscription';

import { invokeChannel, useDaemon, useInvokeQuery } from '@/daemon';

import { LiveTranscript, voiceStreamUrl, wavStreamHeader } from './liveTranscript';

const MAX_RECORDING_MS = 60_000;
const SAMPLE_RATE = 16_000;
const OPEN_TIMEOUT_MS = 8_000;
const KEEPALIVE_MS = 5_000;
/** Time for Deepgram to return the last words after `Finalize`. */
const FINALIZE_WAIT_MS = 800;

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'transcribing';

/**
 * Dictation through the host, like the web app: live audio streamed over the
 * host's Deepgram WebSocket when it has a Deepgram key, otherwise a recorded
 * clip sent to `voice:transcribe`. Either way the host cleans up the text.
 */
export function useVoiceDictation(onText: (text: string) => void) {
  const { client, profile } = useDaemon();
  const affordances = useInvokeQuery<RemotePwaAffordances>('remote:pwa-affordances', [], { staleTime: 5 * 60_000 });
  const voice = affordances.data?.voiceTranscription;
  const mode: VoiceTranscriptionMode | null = voice?.availableModes.includes(voice.defaultMode)
    ? voice.defaultMode
    : voice?.availableModes[0] ?? null;

  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [preview, setPreview] = useState('');
  const [error, setError] = useState<string | null>(null);

  const socket = useRef<WebSocket | null>(null);
  const transcript = useRef<LiveTranscript | null>(null);
  const sentHeader = useRef(false);
  const startedAt = useRef(0);
  const keepAlive = useRef<ReturnType<typeof setInterval> | null>(null);

  const { stream } = useAudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: 'int16',
    onBuffer: buffer => {
      const open = socket.current;
      if (open?.readyState !== WebSocket.OPEN) return;
      if (!sentHeader.current) {
        open.send(wavStreamHeader(buffer.sampleRate));
        sentHeader.current = true;
      }
      open.send(buffer.data);
    },
  });
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  const clearTimers = () => {
    if (keepAlive.current !== null) clearInterval(keepAlive.current);
    keepAlive.current = null;
  };
  const fail = (cause: unknown) => {
    clearTimers();
    socket.current?.close();
    socket.current = null;
    setPhase('idle');
    setPreview('');
    setError(cause instanceof Error ? cause.message : String(cause));
  };

  const startStreaming = async () => {
    const live = new LiveTranscript(Date.now());
    transcript.current = live;
    sentHeader.current = false;
    let serverError: string | null = null;
    const ws = await openSocket(voiceStreamUrl(profile.baseUrl), profile.token, data => {
      serverError = live.receive(data, Date.now()) ?? serverError;
      setPreview(live.preview);
    });
    socket.current = ws;
    // Finishing detaches the socket before closing it, so a close while it is
    // still attached means the host or Deepgram gave up.
    ws.onclose = () => {
      if (socket.current !== ws) return;
      socket.current = null;
      stream.stop();
      fail(serverError ?? 'The voice connection closed.');
    };
    await stream.start();
    if (socket.current !== ws) {
      stream.stop();
      throw new Error(serverError ?? 'The voice connection closed.');
    }
    keepAlive.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }, KEEPALIVE_MS);
  };

  const finishStreaming = async () => {
    stream.stop();
    const ws = socket.current;
    socket.current = null;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'Finalize' }));
      await new Promise(resolve => setTimeout(resolve, FINALIZE_WAIT_MS));
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
    }
    ws?.close();
    const live = transcript.current;
    if (!live?.rawText) return '';
    const stoppedAt = Date.now();
    const request: VoiceStreamingFinalizeRequest = {
      rawText: live.rawText,
      durationMs: stoppedAt - startedAt.current,
      language: 'en',
      timings: { asrMs: stoppedAt - startedAt.current, firstTranscriptMs: live.firstTranscriptMs },
      metadata: live.metadata,
    };
    const result = await invokeChannel<VoiceTranscriptionResult>(client, 'voice:finalize-streaming', [request]);
    return result.text;
  };

  const startRecording = async () => {
    await recorder.prepareToRecordAsync();
    recorder.record();
  };

  const finishRecording = async () => {
    await recorder.stop();
    if (!recorder.uri) throw new Error('Voice recording was empty.');
    const request: VoiceTranscriptionRequest = {
      audioDataUrl: await fileToDataUrl(recorder.uri),
      mimeType: 'audio/mp4',
      durationMs: Date.now() - startedAt.current,
      language: 'en',
    };
    const result = await invokeChannel<VoiceTranscriptionResult>(client, 'voice:transcribe', [request]);
    return result.text;
  };

  const stop = async () => {
    if (phase !== 'listening') return;
    clearTimers();
    setPhase('transcribing');
    try {
      const text = mode === 'streaming' ? await finishStreaming() : await finishRecording();
      if (text.trim()) onText(text.trim());
      setPhase('idle');
      setPreview('');
    } catch (cause) {
      fail(cause);
    } finally {
      socket.current?.close();
      socket.current = null;
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
  };
  const stopAtLimit = useEffectEvent(() => void stop());
  useEffect(() => {
    if (phase !== 'listening') return;
    const limit = setTimeout(stopAtLimit, MAX_RECORDING_MS);
    return () => clearTimeout(limit);
  }, [phase]);

  const start = async () => {
    if (!mode || phase !== 'idle') return;
    setError(null);
    setPreview('');
    setPhase('starting');
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error('Allow microphone access in Settings to dictate.');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      startedAt.current = Date.now();
      if (mode === 'streaming') await startStreaming();
      else await startRecording();
      setPhase('listening');
    } catch (cause) {
      stream.stop();
      fail(cause);
    }
  };

  // useAudioStream releases the microphone itself when the screen goes away.
  useEffect(() => () => {
    clearTimers();
    const ws = socket.current;
    socket.current = null;
    ws?.close();
  }, []);

  return {
    available: mode !== null,
    phase,
    preview,
    error,
    clearError: () => setError(null),
    toggle: () => void (phase === 'listening' ? stop() : start()),
  };
}

// React Native's WebSocket takes request headers as a third argument; the DOM typings don't know it.
const HeaderWebSocket = WebSocket as unknown as new (
  url: string,
  protocols: string[] | null,
  options: { headers: Record<string, string> },
) => WebSocket;

/** Opens the host's voice socket. The bearer token goes in a header, never the URL. */
function openSocket(url: string, token: string, onText: (data: string) => void): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new HeaderWebSocket(url, null, { headers: { Authorization: `Bearer ${token}` } });
    ws.binaryType = 'arraybuffer';
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Voice service did not respond.'));
    }, OPEN_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timeout);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Could not reach the voice service on this host.'));
    };
    ws.onmessage = event => {
      if (typeof event.data === 'string') onText(event.data);
    };
  });
}

async function fileToDataUrl(uri: string): Promise<string> {
  const blob = await (await fetch(uri)).blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]*;/, 'data:audio/mp4;'));
    reader.onerror = () => reject(new Error('Could not read the recording.'));
    reader.readAsDataURL(blob);
  });
}
