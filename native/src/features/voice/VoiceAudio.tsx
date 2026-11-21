import { RecordingPresets, useAudioPlayer, useAudioRecorder, useAudioStream, type AudioPlayer, type AudioRecorder } from 'expo-audio';
import { useEffect } from 'react';

const SAMPLE_RATE = 16_000;
/** Mono speech at 64 kbps keeps a 15-minute clip near 7 MB, under the host's 10 MB cap. */
const CLIP_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64_000, isMeteringEnabled: true };

type Stream = ReturnType<typeof useAudioStream>['stream'];
type StreamBuffer = Parameters<NonNullable<NonNullable<Parameters<typeof useAudioStream>[0]>['onBuffer']>>[0];

/** The microphone stream, the clip recorder and the countdown sound dictation uses. */
export interface VoiceAudioObjects {
  stream: Stream;
  recorder: AudioRecorder;
  countdownCue: AudioPlayer;
}

/**
 * Creates dictation's native audio objects, and releases them when it unmounts. Creating them
 * costs about as long as a frame, so a screen mounts this on the first dictation, not on open.
 */
export function VoiceAudio({ onReady, onBuffer }: {
  onReady: (audio: VoiceAudioObjects | null) => void;
  onBuffer: (buffer: StreamBuffer) => void;
}) {
  const { stream } = useAudioStream({ sampleRate: SAMPLE_RATE, channels: 1, encoding: 'int16', onBuffer });
  const recorder = useAudioRecorder(CLIP_OPTIONS);
  const countdownCue = useAudioPlayer(require('../../../assets/sounds/countdown.wav'));
  useEffect(() => {
    onReady({ stream, recorder, countdownCue });
    return () => onReady(null);
  }, [onReady, stream, recorder, countdownCue]);
  return null;
}
