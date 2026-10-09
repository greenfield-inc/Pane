import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
  useAudioStream,
} from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type {
  VoiceStreamingFinalizeRequest,
  VoiceTranscriptionMode,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from '@shared/types/voiceTranscription';

import { invokeChannel, useDaemon } from '@/daemon';

import { useAffordances } from '../hosts/hostSettings';

import { LiveTranscript, voiceStreamUrl, wavStreamHeader } from './liveTranscript';
import { MAX_RECORDING_MS, SilenceWatch, pcmLevelDbfs, recordingClock } from './recordingLimits';
import { micMode } from './voiceKeys';

const SAMPLE_RATE = 16_000;
const OPEN_TIMEOUT_MS = 8_000;
const KEEPALIVE_MS = 5_000;
/** Time for Deepgram to return the last words after `Finalize`. */
const FINALIZE_WAIT_MS = 800;
const CONFIRM_POLL_MS = 100;
/** How often a recording checks its limit, its silence and the recorder's level meter. */
const TICK_MS = 250;
const SILENCE_NOTICE = 'Stopped after 30 seconds of silence.';
const LIMIT_NOTICE = 'Stopped at the 15-minute limit.';
/** Mono speech at 64 kbps keeps a 15-minute clip near 7 MB, under the host's 10 MB cap. */
const CLIP_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64_000, isMeteringEnabled: true };

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'transcribing';

/**
 * Dictation through the host, like the web app: live audio streamed over the
 * host's Deepgram WebSocket when it has a Deepgram key, otherwise a recorded
 * clip sent to `voice:transcribe`. Either way the host cleans up the text.
 */
export function useVoiceDictation(onText: (text: string) => void) {
  const { client, profile } = useDaemon();
  const affordances = useAffordances();
  const voice = affordances.data?.voiceTranscription;
  const mode = voice ? micMode(voice) : null;

  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [preview, setPreview] = useState('');
  const [error, setError] = useState<string | null>(null);

  const socket = useRef<WebSocket | null>(null);
  const transcript = useRef<LiveTranscript | null>(null);
  const sentHeader = useRef(false);
  /** When the current recording started; the timer, the countdown and the limit all count from it. */
  const [startedAt, setStartedAt] = useState(0);
  const silence = useRef(new SilenceWatch(0));
  const cuedCountdown = useRef(false);
  const keepAlive = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);
  // The mode this recording started in; a save from the setup sheet can start one the affordances don't show yet.
  const activeMode = useRef<VoiceTranscriptionMode>('streaming');

  const { stream } = useAudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: 'int16',
    onBuffer: buffer => {
      silence.current.hear(pcmLevelDbfs(buffer.data), Date.now());
      const open = socket.current;
      if (open?.readyState !== WebSocket.OPEN) return;
      if (!sentHeader.current) {
        open.send(wavStreamHeader(buffer.sampleRate));
        sentHeader.current = true;
      }
      open.send(buffer.data);
    },
  });
  const recorder = useAudioRecorder(CLIP_OPTIONS);
  const countdownCue = useAudioPlayer(require('../../../assets/sounds/countdown.wav'));

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

  /** With `confirmMs`, also waits that long for the host or Deepgram to refuse the key. */
  const startStreaming = async (confirmMs: number) => {
    const live = new LiveTranscript(Date.now());
    transcript.current = live;
    sentHeader.current = false;
    let serverError: string | null = null;
    const ws = await openSocket(voiceStreamUrl(profile.baseUrl), profile.token, data => {
      serverError = live.receive(data, Date.now()) ?? serverError;
      setPreview(live.preview);
    });
    if (!mounted.current) {
      // The screen closed while the socket was opening.
      ws.close();
      return;
    }
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
    // The host accepts the socket before Deepgram answers, so a refused key closes it a moment later.
    for (let waited = 0; waited < confirmMs; waited += CONFIRM_POLL_MS) {
      await new Promise(resolve => setTimeout(resolve, CONFIRM_POLL_MS));
      if (socket.current !== ws) throw new Error(serverError ?? 'The voice connection closed.');
    }
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
      durationMs: stoppedAt - startedAt,
      language: 'en',
      timings: { asrMs: stoppedAt - startedAt, firstTranscriptMs: live.firstTranscriptMs },
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
      durationMs: Date.now() - startedAt,
      language: 'en',
    };
    const result = await invokeChannel<VoiceTranscriptionResult>(client, 'voice:transcribe', [request]);
    return result.text;
  };

  /** Stops and inserts the text so far; `notice` then shows in the error line. */
  const stop = async (notice?: string) => {
    if (phase !== 'listening') return;
    clearTimers();
    setPhase('transcribing');
    try {
      const text = activeMode.current === 'streaming' ? await finishStreaming() : await finishRecording();
      if (text.trim()) onText(text.trim());
      setPhase('idle');
      setPreview('');
      if (notice) setError(notice);
    } catch (cause) {
      fail(cause);
    } finally {
      socket.current?.close();
      socket.current = null;
      await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    }
  };
  /** Returns true once it has stopped the recording. */
  const tick = useEffectEvent((): boolean => {
    const now = Date.now();
    if (activeMode.current === 'recorded') silence.current.hear(recorder.getStatus().metering ?? -160, now);
    if (now - startedAt >= MAX_RECORDING_MS) {
      void stop(LIMIT_NOTICE);
      return true;
    }
    if (silence.current.silent(now)) {
      void stop(SILENCE_NOTICE);
      return true;
    }
    if (!cuedCountdown.current && recordingClock(now - startedAt).countdown) {
      cuedCountdown.current = true;
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      void countdownCue.seekTo(0).then(() => countdownCue.play());
    }
    return false;
  });
  useEffect(() => {
    if (phase !== 'listening') return;
    const timer = setInterval(() => {
      if (tick()) clearInterval(timer);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [phase]);

  /**
   * Starts recording in `forced`, or the host's mode. Resolves to why it
   * could not start, or null. `confirmMs` holds a live start that long, so a
   * just-saved key the provider refuses fails here instead of a moment later.
   */
  const start = async (forced?: VoiceTranscriptionMode, confirmMs = 0): Promise<string | null> => {
    const startMode = forced ?? mode;
    if (!startMode || phase !== 'idle') return 'Voice is not set up on this host.';
    activeMode.current = startMode;
    setError(null);
    setPreview('');
    setPhase('starting');
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) throw new Error('Allow microphone access in Settings to dictate.');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const now = Date.now();
      setStartedAt(now);
      silence.current = new SilenceWatch(now);
      cuedCountdown.current = false;
      if (startMode === 'streaming') await startStreaming(confirmMs);
      else await startRecording();
      setPhase('listening');
      return null;
    } catch (cause) {
      stream.stop();
      fail(cause);
      return cause instanceof Error ? cause.message : String(cause);
    }
  };

  // useAudioStream releases the microphone itself when the screen goes away.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimers();
      const ws = socket.current;
      socket.current = null;
      ws?.close();
    };
  }, []);

  return {
    /** The host has the keys for at least one mode. */
    available: mode !== null,
    /** False until the host's voice setup has loaded. */
    loaded: voice !== undefined,
    /** The host's voice setup: which keys it has (never their values) and the modes it can run. */
    host: voice,
    start,
    phase,
    /** When the current recording started, in epoch ms. */
    startedAt,
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
