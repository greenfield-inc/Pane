import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  VoiceDeepgramStreamingMetadata,
  VoiceDeepgramTokenResult,
  VoiceStreamingFinalizeRequest,
  VoiceTranscriptionMode,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from '../../../../shared/types/voiceTranscription';
import {
  buildDeepgramListenUrl,
  parseDeepgramLiveMessage,
  readResultsMetadata,
} from '../utils/deepgramLive';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

const MAX_RECORDING_MS = 60_000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const STREAM_CHUNK_MS = 250;
const STREAM_FINALIZE_WAIT_MS = 800;
const STREAM_OPEN_TIMEOUT_MS = 8_000;
const STREAM_KEEPALIVE_MS = 5_000;
const DEEPGRAM_AUTH_PROTOCOL = 'bearer';

const PREFERRED_RECORDING_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
] as const;

interface UseRemoteVoiceDictationOptions {
  mode: VoiceTranscriptionMode;
  onTranscript: (text: string) => void;
  onTranscribeAudio?: (request: VoiceTranscriptionRequest) => Promise<VoiceTranscriptionResult>;
  onCreateStreamingSocket?: () => WebSocket;
  onGetDeepgramToken?: () => Promise<VoiceDeepgramTokenResult>;
  onFinalizeStreamingAudio?: (request: VoiceStreamingFinalizeRequest) => Promise<VoiceTranscriptionResult>;
}

interface UseRemoteVoiceDictationResult {
  isRecording: boolean;
  isTranscribing: boolean;
  activeMode: VoiceTranscriptionMode | null;
  interimTranscript: string;
  streamingTranscript: string;
  error: string | null;
  clearError: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  toggle: () => Promise<void>;
}

export function useRemoteVoiceDictation({
  mode,
  onTranscript,
  onTranscribeAudio,
  onCreateStreamingSocket,
  onGetDeepgramToken,
  onFinalizeStreamingAudio,
}: UseRemoteVoiceDictationOptions): UseRemoteVoiceDictationResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [activeMode, setActiveMode] = useState<VoiceTranscriptionMode | null>(null);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [streamingTranscript, setStreamingTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef(0);
  const recordingMimeTypeRef = useRef('audio/webm');
  const recordingTimerRef = useRef<number | null>(null);
  const streamingKeepaliveTimerRef = useRef<number | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const stopStreamingRef = useRef<() => Promise<void>>(async () => {});
  const finalSegmentsRef = useRef<string[]>([]);
  const interimTranscriptRef = useRef('');
  const firstTranscriptMsRef = useRef<number | undefined>(undefined);
  const deepgramMetadataRef = useRef<VoiceDeepgramStreamingMetadata | undefined>(undefined);

  const clearError = useCallback(() => setError(null), []);

  const clearRecordingTimer = useCallback(() => {
    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }, []);

  const clearStreamingKeepaliveTimer = useCallback(() => {
    if (streamingKeepaliveTimerRef.current !== null) {
      window.clearInterval(streamingKeepaliveTimerRef.current);
      streamingKeepaliveTimerRef.current = null;
    }
  }, []);

  const stopMediaStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const resetStreamingState = useCallback(() => {
    finalSegmentsRef.current = [];
    interimTranscriptRef.current = '';
    firstTranscriptMsRef.current = undefined;
    deepgramMetadataRef.current = undefined;
    setInterimTranscript('');
    setStreamingTranscript('');
  }, []);

  const finishRecorded = useCallback(async () => {
    clearRecordingTimer();
    const durationMs = Math.max(0, Date.now() - recordingStartedAtRef.current);
    const chunks = chunksRef.current;
    chunksRef.current = [];
    stopMediaStream();
    setIsRecording(false);
    setActiveMode(null);

    if (chunks.length === 0) {
      setError('Voice recording was empty.');
      return;
    }

    const mimeType = normalizeMimeType(recordingMimeTypeRef.current);
    const audioBlob = new Blob(chunks, { type: mimeType });
    if (audioBlob.size === 0) {
      setError('Voice recording was empty.');
      return;
    }
    if (audioBlob.size > MAX_AUDIO_BYTES) {
      setError('Recording is too large. Keep voice clips under 10 MB.');
      return;
    }
    if (!onTranscribeAudio) {
      setError('Voice transcription is unavailable.');
      return;
    }

    setIsTranscribing(true);
    try {
      const audioDataUrl = await blobToDataUrl(audioBlob);
      const result = await onTranscribeAudio({
        audioDataUrl,
        mimeType,
        durationMs,
        language: 'en',
      });
      if (result.text.trim()) {
        onTranscript(result.text.trim());
      }
    } catch (err) {
      setError(getVoiceErrorMessage(err));
    } finally {
      setIsTranscribing(false);
    }
  }, [clearRecordingTimer, onTranscribeAudio, onTranscript, stopMediaStream]);

  const startRecorded = useCallback(async () => {
    if (!onTranscribeAudio) {
      setError('Voice transcription is unavailable.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !('MediaRecorder' in globalThis)) {
      setError('Voice recording is not supported in this browser.');
      return;
    }

    setError(null);
    resetStreamingState();
    try {
      const selectedMimeType = selectRecordingMimeType();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = selectedMimeType
        ? new MediaRecorder(stream, { mimeType: selectedMimeType })
        : new MediaRecorder(stream);

      chunksRef.current = [];
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingMimeTypeRef.current = normalizeMimeType(recorder.mimeType || selectedMimeType || 'audio/webm');
      recordingStartedAtRef.current = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        setError('Voice recording failed.');
      };
      recorder.onstop = () => {
        void finishRecorded();
      };

      recorder.start();
      setActiveMode('recorded');
      setIsRecording(true);
      recordingTimerRef.current = window.setTimeout(() => {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      }, MAX_RECORDING_MS);
    } catch (err) {
      stopMediaStream();
      setIsRecording(false);
      setActiveMode(null);
      setError(getVoiceErrorMessage(err));
    }
  }, [finishRecorded, onTranscribeAudio, resetStreamingState, stopMediaStream]);

  const handleDeepgramMessage = useCallback((data: string) => {
    const resultMetadata = readResultsMetadata(data);
    if (resultMetadata) {
      deepgramMetadataRef.current = mergeDeepgramMetadata(deepgramMetadataRef.current, resultMetadata);
    }

    const message = parseDeepgramLiveMessage(data);
    if (message.type === 'metadata') {
      deepgramMetadataRef.current = mergeDeepgramMetadata(deepgramMetadataRef.current, message.metadata);
      return;
    }
    if (message.type === 'error') {
      setError(message.message);
      return;
    }
    if (message.type !== 'transcript') {
      return;
    }

    const elapsedMs = Math.max(0, Math.round(performance.now() - recordingStartedAtRef.current));
    firstTranscriptMsRef.current ??= elapsedMs;

    if (message.update.isFinal) {
      finalSegmentsRef.current.push(message.update.transcript);
      interimTranscriptRef.current = '';
      setInterimTranscript('');
      setStreamingTranscript(finalSegmentsRef.current.join(' '));
      return;
    }

    interimTranscriptRef.current = message.update.transcript;
    setInterimTranscript(message.update.transcript);
  }, []);

  const startStreaming = useCallback(async () => {
    if ((!onCreateStreamingSocket && !onGetDeepgramToken) || !onFinalizeStreamingAudio) {
      setError('Live voice transcription is unavailable.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !('MediaRecorder' in globalThis) || !('WebSocket' in globalThis)) {
      setError('Live voice recording is not supported in this browser.');
      return;
    }

    setError(null);
    resetStreamingState();
    setIsTranscribing(true);
    try {
      const selectedMimeType = selectRecordingMimeType();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let socket: WebSocket;
      if (onCreateStreamingSocket) {
        socket = await openStreamingSocket(onCreateStreamingSocket(), handleDeepgramMessage);
      } else {
        if (!onGetDeepgramToken) {
          throw new Error('Live voice transcription is unavailable.');
        }
        const token = await onGetDeepgramToken();
        socket = await openDeepgramSocket(token.accessToken, handleDeepgramMessage);
      }
      const recorder = selectedMimeType
        ? new MediaRecorder(stream, { mimeType: selectedMimeType })
        : new MediaRecorder(stream);

      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      socketRef.current = socket;
      recordingMimeTypeRef.current = normalizeMimeType(recorder.mimeType || selectedMimeType || 'audio/webm');
      recordingStartedAtRef.current = performance.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data);
        }
      };
      recorder.onerror = () => {
        setError('Live voice recording failed.');
      };

      recorder.start(STREAM_CHUNK_MS);
      setActiveMode('streaming');
      setIsRecording(true);
      setIsTranscribing(false);
      streamingKeepaliveTimerRef.current = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, STREAM_KEEPALIVE_MS);
      recordingTimerRef.current = window.setTimeout(() => {
        void stopStreamingRef.current();
      }, MAX_RECORDING_MS);
    } catch (err) {
      closeSocket(socketRef);
      stopMediaStream();
      setIsRecording(false);
      setIsTranscribing(false);
      setActiveMode(null);
      setError(getVoiceErrorMessage(err));
    }
  }, [handleDeepgramMessage, onCreateStreamingSocket, onFinalizeStreamingAudio, onGetDeepgramToken, resetStreamingState, stopMediaStream]);

  const stopStreaming = useCallback(async () => {
    const socket = socketRef.current;
    const recorder = mediaRecorderRef.current;
    if (!socket && !recorder) {
      return;
    }

    clearRecordingTimer();
    clearStreamingKeepaliveTimer();
    setIsRecording(false);
    setIsTranscribing(true);
    const stoppedAtMs = performance.now();

    try {
      if (recorder && recorder.state !== 'inactive') {
        await stopRecorder(recorder);
      }
      stopMediaStream();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'Finalize' }));
        await delay(STREAM_FINALIZE_WAIT_MS);
        socket.send(JSON.stringify({ type: 'CloseStream' }));
      }

      const rawText = buildStreamingRawTranscript(finalSegmentsRef.current, interimTranscriptRef.current);
      const asrMs = Math.max(0, Math.round(performance.now() - recordingStartedAtRef.current));
      const durationMs = Math.max(0, Math.round(stoppedAtMs - recordingStartedAtRef.current));
      if (!onFinalizeStreamingAudio) {
        setError('Live voice transcription cleanup is unavailable.');
        return;
      }

      const result = await onFinalizeStreamingAudio({
        rawText,
        durationMs,
        language: 'en',
        timings: {
          asrMs,
          firstTranscriptMs: firstTranscriptMsRef.current,
        },
        metadata: deepgramMetadataRef.current,
      });
      if (result.text.trim()) {
        onTranscript(result.text.trim());
      }
    } catch (err) {
      setError(getVoiceErrorMessage(err));
    } finally {
      closeSocket(socketRef);
      mediaRecorderRef.current = null;
      setIsTranscribing(false);
      setActiveMode(null);
      resetStreamingState();
    }
  }, [clearRecordingTimer, clearStreamingKeepaliveTimer, onFinalizeStreamingAudio, onTranscript, resetStreamingState, stopMediaStream]);

  useEffect(() => {
    stopStreamingRef.current = stopStreaming;
  }, [stopStreaming]);

  const stopRecorded = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      return;
    }
    clearRecordingTimer();
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
  }, [clearRecordingTimer]);

  const start = useCallback(async () => {
    if (isRecording || isTranscribing) {
      return;
    }
    if (mode === 'streaming') {
      await startStreaming();
      return;
    }
    await startRecorded();
  }, [isRecording, isTranscribing, mode, startRecorded, startStreaming]);

  const stop = useCallback(async () => {
    if (activeMode === 'streaming') {
      await stopStreaming();
      return;
    }
    await stopRecorded();
  }, [activeMode, stopRecorded, stopStreaming]);

  const toggle = useCallback(async () => {
    if (isRecording) {
      await stop();
      return;
    }
    await start();
  }, [isRecording, start, stop]);

  useEffect(() => () => {
    clearRecordingTimer();
    clearStreamingKeepaliveTimer();
    const recorder = mediaRecorderRef.current;
    if (recorder) {
      recorder.onstop = null;
      if (recorder.state === 'recording') {
        recorder.stop();
      }
    }
    closeSocket(socketRef);
    stopMediaStream();
  }, [clearRecordingTimer, clearStreamingKeepaliveTimer, stopMediaStream]);

  return {
    isRecording,
    isTranscribing,
    activeMode,
    interimTranscript,
    streamingTranscript,
    error,
    clearError,
    start,
    stop,
    toggle,
  };
}

function selectRecordingMimeType(): string | undefined {
  if (!('MediaRecorder' in globalThis) || !MediaRecorder.isTypeSupported) {
    return undefined;
  }

  return PREFERRED_RECORDING_MIME_TYPES.find(type => MediaRecorder.isTypeSupported(type));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = decodeOptionalBoundary(reader.result, boundary.string);
      if (dataUrl !== undefined) {
        resolve(dataUrl);
      } else {
        reject(new Error('Failed to read voice recording.'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read voice recording.'));
    reader.readAsDataURL(blob);
  });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Browser media and network failures are narrowed to Error before showing a message.
function getVoiceErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return 'Voice transcription failed.';
}

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(';')[0]?.trim().toLowerCase() || 'audio/webm';
}

function openDeepgramSocket(
  accessToken: string,
  onMessage: (data: string) => void,
): Promise<WebSocket> {
  return openStreamingSocket(new WebSocket(buildDeepgramListenUrl(), [DEEPGRAM_AUTH_PROTOCOL, accessToken]), onMessage);
}

function openStreamingSocket(
  socket: WebSocket,
  onMessage: (data: string) => void,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error('Timed out connecting to Deepgram live transcription.'));
    }, STREAM_OPEN_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      window.clearTimeout(timeout);
      resolve(socket);
    }, { once: true });
    socket.addEventListener('error', () => {
      window.clearTimeout(timeout);
      reject(new Error('Failed to connect to Deepgram live transcription.'));
    }, { once: true });
    socket.addEventListener('message', (event) => {
      const message = decodeOptionalBoundary(event.data, boundary.string);
      if (message !== undefined) onMessage(message);
    });
  });
}

function closeSocket(socketRef: { current: WebSocket | null }): void {
  const socket = socketRef.current;
  if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
    socket.close();
  }
  socketRef.current = null;
}

function stopRecorder(recorder: MediaRecorder): Promise<void> {
  return new Promise(resolve => {
    recorder.addEventListener('stop', () => resolve(), { once: true });
    recorder.requestData();
    recorder.stop();
  });
}


function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

function buildStreamingRawTranscript(finalSegments: string[], interim: string): string {
  const finalText = finalSegments.join(' ').trim();
  if (finalText) {
    return finalText;
  }
  return interim.trim();
}

function mergeDeepgramMetadata(
  current: VoiceDeepgramStreamingMetadata | undefined,
  next: VoiceDeepgramStreamingMetadata,
): VoiceDeepgramStreamingMetadata {
  return {
    ...current,
    ...Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined),
    ),
  };
}
