/** The voice provider keys a host keeps in its config. */
export const VOICE_KEY_FIELDS = ['deepgramApiKey', 'falApiKey', 'openRouterApiKey'] as const;
export type VoiceKeyField = typeof VOICE_KEY_FIELDS[number];

const VOICE_KEY_PROVIDERS = {
  deepgramApiKey: 'Deepgram',
  falApiKey: 'fal',
  openRouterApiKey: 'OpenRouter',
} satisfies Record<VoiceKeyField, string>;

/** What the provider said about a key: it took it, it refused it, or Pane couldn't ask. */
export interface VoiceKeyCheck {
  result: 'accepted' | 'rejected' | 'unchecked';
  message: string;
}

const MIN_KEY_LENGTH = 16;
const MAX_KEY_LENGTH = 200;

/**
 * Why `value` can't be the provider's key, with the fix, or null when it could be. Provider keys
 * are 16 to 200 printable ASCII characters with no spaces. Neither line repeats the value.
 */
export function voiceKeyProblem(field: VoiceKeyField, value: string): { message: string; next: string } | null {
  const provider = VOICE_KEY_PROVIDERS[field];
  const reason = value.length > MAX_KEY_LENGTH
    ? `it is ${value.length.toLocaleString('en-US')} characters long, and ${provider} keys are under ${MAX_KEY_LENGTH}`
    : /\s/.test(value)
      ? 'it has spaces or line breaks'
      : /[^\x21-\x7e]/.test(value)
        ? 'it has characters no key has, such as curly quotes or accented letters'
        : value.length < MIN_KEY_LENGTH
          ? `it is ${value.length} characters long, too short for a ${provider} key`
          : null;
  return reason
    ? { message: `That isn't a ${provider} key: ${reason}.`, next: `Copy only the key from ${provider} and paste it again.` }
    : null;
}
