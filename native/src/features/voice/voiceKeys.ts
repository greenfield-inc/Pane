import type { RemotePwaVoiceTranscriptionAffordance, RemoteSettingsPatch } from '@shared/types/remoteDaemon';
import type { VoiceTranscriptionMode } from '@shared/types/voiceTranscription';

export type VoiceKey = Exclude<keyof RemoteSettingsPatch, 'terminalShortcuts'>;
type Voice = RemotePwaVoiceTranscriptionAffordance;

/** Live streams to Deepgram, recorded sends a clip to fal. OpenRouter only cleans up the text, in either mode. */
const REQUIRED_KEY: Record<VoiceTranscriptionMode, VoiceKey> = {
  streaming: 'deepgramApiKey',
  recorded: 'falApiKey',
};

const CONFIGURED: Record<VoiceKey, keyof Voice['configured']> = {
  deepgramApiKey: 'deepgram',
  openRouterApiKey: 'openRouter',
  falApiKey: 'fal',
};

/** The mode the mic records in, or null when the host can't record yet and the mic opens setup. */
export function micMode(voice: Voice): VoiceTranscriptionMode | null {
  return voice.availableModes.includes(voice.defaultMode) ? voice.defaultMode : voice.availableModes[0] ?? null;
}

/** The host has the mode's key but still can't run it: a host before v2.4.159, which also needs OpenRouter. */
export function hostNeedsUpdate(mode: VoiceTranscriptionMode, voice: Voice): boolean {
  return voice.configured[CONFIGURED[REQUIRED_KEY[mode]]] && !voice.availableModes.includes(mode);
}

/** The key `mode` needs, then the cleanup key, each with whether the host already has it. */
export function voiceKeysFor(mode: VoiceTranscriptionMode, voice: Voice) {
  const cleanupRequired = hostNeedsUpdate(mode, voice);
  return ([REQUIRED_KEY[mode], 'openRouterApiKey'] as const).map(key => ({
    key,
    set: voice.configured[CONFIGURED[key]],
    optional: key === 'openRouterApiKey' && !cleanupRequired,
  }));
}

/** Every key `mode` needs is on the host or typed, so recording can start. */
export function canStartVoice(mode: VoiceTranscriptionMode, voice: Voice, typed: Partial<Record<VoiceKey, string>>): boolean {
  return voiceKeysFor(mode, voice).every(item => item.optional || item.set || Boolean(typed[item.key]?.trim()));
}

/** `message` with any of `secrets` masked, so an error can never show a key that was typed. */
export function maskSecrets(message: string, secrets: readonly string[]): string {
  return secrets.filter(secret => secret.length >= 4).reduce((text, secret) => text.split(secret).join('•••'), message);
}
