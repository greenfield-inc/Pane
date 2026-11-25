import { useEffect, type CSSProperties } from 'react';
import { agentLabel } from '../../../../shared/agents';
import { plainProfileAgent } from '../../../../shared/agentProfiles';
import { agentIdIcon } from '../ui/brandIconRegistry';
import { cn } from '../../utils/cn';
import { profileAvatar, profileDisplayName } from '../../utils/profileAvatar';
import { ensureProfilePhotos, profilePicture, useProfilesStore } from '../../stores/profilesStore';

interface ProfileAvatarProps {
  /** The Agent Farm profile (`plugin/profile[:variant]`); `pane/<agent>` is the agent on its own. */
  profileRef?: string;
  /** The agent, for a Session or choice with no profile. */
  agent?: string;
  /** A picture to show instead of the profile's own photo on this computer (the Profiles tab's photo menu). */
  picture?: string;
  /** Shows the initials even when the profile has a photo (the photo menu's "Generated" preview). */
  generated?: boolean;
  /** Diameter in px; the avatar always fills exactly this box. */
  size: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * A profile's avatar (T-63): your photo or the plugin's picture, else its initials on a tinted circle (`--color-avatar-N`),
 * else Claude's or Codex's logo for the agent on its own, else the agent's initial.
 */
export function ProfileAvatar({ profileRef, agent, picture, generated, size, className, style }: ProfileAvatarProps) {
  const plain = profileRef ? plainProfileAgent(profileRef) : undefined;
  const named = profileRef && !plain;
  // Your photo here, else the plugin's own picture (T-63 PR 5); loaded once, the first time an avatar shows.
  const stored = useProfilesStore(state => (named && !generated ? profilePicture(state.photos, profileRef) : undefined));
  useEffect(() => { if (named) ensureProfilePhotos(); }, [named]);
  const face = profileAvatar({ profileRef, agent, picture: generated ? undefined : picture ?? stored });
  const label = named ? `Profile ${profileDisplayName(profileRef)}` : `${agentLabel(plain ?? agent ?? '')}, no profile`;
  const box: CSSProperties = { width: size, height: size, fontSize: Math.round(size * 0.42), ...style };
  if (face.kind === 'initials') {
    const tone = `var(--color-avatar-${face.tone})`;
    // The letters lean toward the text colour so they keep WCAG AA contrast on their tint (T-63 PR 5, axe).
    box.color = `color-mix(in srgb, ${tone} 55%, var(--color-text-primary))`;
    box.backgroundColor = `color-mix(in srgb, ${tone} 18%, var(--color-surface-primary))`;
    box.boxShadow = `inset 0 0 0 1px color-mix(in srgb, ${tone} 30%, transparent)`;
  }
  return (
    <span
      role="img"
      aria-label={label}
      title={named ? `${profileDisplayName(profileRef)} · ${profileRef}` : label}
      data-testid="profile-avatar"
      data-avatar={face.kind}
      className={cn(
        'relative inline-flex flex-none select-none items-center justify-center overflow-hidden rounded-full font-semibold leading-none tracking-tight',
        (face.kind === 'logo' || face.kind === 'letter') && 'bg-surface-secondary text-text-secondary shadow-[inset_0_0_0_1px_var(--color-border-primary)]',
        className,
      )}
      style={box}
    >
      {face.kind === 'picture' && <img src={face.src} alt="" className="block h-full w-full object-cover" />}
      {/* The avatar is one image named by its label; its letters are decoration. */}
      {face.kind === 'initials' && <span aria-hidden="true">{face.text}</span>}
      {face.kind === 'letter' && <span aria-hidden="true">{face.text}</span>}
      {face.kind === 'logo' && agentIdIcon(face.agent, 'h-[58%] w-[58%]')}
    </span>
  );
}
