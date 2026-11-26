import { agentConfig, agentLabel } from '../../../shared/agents';
import { plainProfileAgent } from '../../../shared/agentProfiles';

export { profileDisplayName } from '../../../shared/agentProfiles';

/**
 * What a Session's or profile's avatar shows (T-63): a picture when it has one, else a profile's
 * initials on a tinted circle, else a plain agent's logo (Claude, Codex), else the agent's initial.
 */
export type ProfileAvatarFace =
  | { kind: 'picture'; src: string }
  | { kind: 'initials'; text: string; tone: number }
  | { kind: 'logo'; agent: string }
  | { kind: 'letter'; text: string };

/** How many `--color-avatar-N` tints the themes define. */
const AVATAR_TONES = 8;

function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

/** `plugin/profile` without its variant. */
function qualified(ref: string): string {
  return ref.split(':')[0];
}

/** Initials of a title: the first letters of its first two words, or its first two letters (SEO → SE). */
function titleInitials(title: string): string {
  const words = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return '';
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0].slice(0, 2)).toUpperCase();
}

/** `title` is Agent Farm's title for the profile (T-83), when known: the initials come from it. */
export function profileAvatar({ profileRef, agent, picture, title }: { profileRef?: string; agent?: string; picture?: string; title?: string }): ProfileAvatarFace {
  if (picture) return { kind: 'picture', src: picture };
  const plain = profileRef ? plainProfileAgent(profileRef) : undefined;
  if (profileRef && !plain) {
    const name = qualified(profileRef);
    const [plugin = '', profile = ''] = name.split('/');
    const fromTitle = title ? titleInitials(title) : '';
    const text = fromTitle || (plugin === profile || !profile ? (profile || plugin).slice(0, 2) : `${plugin[0]}${profile[0]}`).toUpperCase();
    return { kind: 'initials', text, tone: (hash(name) % AVATAR_TONES) + 1 };
  }
  const id = plain ?? agent ?? '';
  if (agentConfig(id)?.chat?.profileModel) return { kind: 'logo', agent: id };
  return { kind: 'letter', text: (agentLabel(id)[0] ?? '?').toUpperCase() };
}
