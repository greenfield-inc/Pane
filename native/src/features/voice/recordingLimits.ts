/** The longest a dictation records before it stops on its own. */
export const MAX_RECORDING_MS = 15 * 60_000;
/** A dictation stops after this long below `SILENCE_DBFS`. */
const SILENCE_STOP_MS = 30_000;
/**
 * Quiet-room noise on a phone mic sits around -60 to -70 dBFS and speech at
 * arm's length around -35 to -20, so -50 leaves soft speech counted as sound;
 * wind and traffic usually land above it too, which only keeps recording going.
 */
const SILENCE_DBFS = -50;
/** What a level meter reports for no signal. */
const FLOOR_DBFS = -160;
const COUNTDOWN_SECONDS = 60;

/**
 * The timer beside the mic, `elapsedMs` into a recording: the time so far,
 * then in the last minute the time left, down to 0:00.
 */
export function recordingClock(elapsedMs: number): { label: string; countdown: boolean; seconds: number } {
  const left = Math.max(0, Math.floor((MAX_RECORDING_MS - elapsedMs) / 1000));
  const countdown = left < COUNTDOWN_SECONDS;
  const seconds = countdown ? left : Math.floor(elapsedMs / 1000);
  return { label: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, countdown, seconds };
}

/** RMS level of 16-bit little-endian PCM, in dBFS. */
export function pcmLevelDbfs(data: ArrayBuffer): number {
  const samples = new Int16Array(data, 0, Math.floor(data.byteLength / 2));
  if (samples.length === 0) return FLOOR_DBFS;
  let sum = 0;
  for (const sample of samples) sum += (sample / 32768) ** 2;
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? Math.max(FLOOR_DBFS, 20 * Math.log10(rms)) : FLOOR_DBFS;
}

/** Tracks when the mic last heard something louder than `SILENCE_DBFS`. */
export class SilenceWatch {
  constructor(private lastSoundAt: number) {}

  hear(levelDbfs: number, now: number): void {
    if (levelDbfs > SILENCE_DBFS) this.lastSoundAt = now;
  }

  silent(now: number): boolean {
    return now - this.lastSoundAt >= SILENCE_STOP_MS;
  }
}
