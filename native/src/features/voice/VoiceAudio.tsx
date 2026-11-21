import {
  RecordingPresets, useAudioPlayer, useAudioRecorder, useAudioStream,
  type AudioPlayer, type AudioRecorder, type AudioStream, type AudioStreamBuffer,
} from 'expo-audio';
import { useEffect, useEffectEvent } from 'react';

const SAMPLE_RATE = 16_000;
/** Mono speech at 64 kbps keeps a 15-minute clip near 7 MB, under the host's 10 MB cap. */
const CLIP_OPTIONS = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 64_000, isMeteringEnabled: true };

/** The microphone stream, the clip recorder and the countdown sound dictation uses. */
export interface VoiceAudioObjects {
  stream: AudioStream;
  recorder: AudioRecorder;
  countdownCue: AudioPlayer;
}

/**
 * Creates dictation's native audio objects, and releases them when it unmounts. Creating them
 * costs about as long as a frame, so a screen mounts this on the first dictation, not on open.
 */
export function VoiceAudio({ onReady, onBuffer }: {
  onReady: (audio: VoiceAudioObjects | null) => void;
  onBuffer: (buffer: AudioStreamBuffer) => void;
}) {
  const { stream } = useAudioStream({ sampleRate: SAMPLE_RATE, channels: 1, encoding: 'int16', onBuffer });
  const recorder = useAudioRecorder(CLIP_OPTIONS);
  const countdownCue = useAudioPlayer(require('../../../assets/sounds/countdown.wav'));
  const ready = useEffectEvent((audio: VoiceAudioObjects | null) => onReady(audio));
  useEffect(() => {
    ready({ stream, recorder, countdownCue });
    return () => ready(null);
  }, [stream, recorder, countdownCue]);
  return null;
}
