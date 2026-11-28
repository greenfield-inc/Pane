import { useMemo } from 'react';
import { launchProfileRef, plainProfileAgent } from '../../../../shared/agentProfiles';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import { isProfilesEnabled, useConfigStore } from '../../stores/configStore';
import { ProfileAvatar } from '../profiles/ProfileAvatar';
import type { ChatPhoto } from './chatRendering';
import { ChatProfileHeading } from './ChatProfileHeading';

const avatar = (ref: string, size: number) => <ProfileAvatar profileRef={ref} size={size} />;

/**
 * The agent's photo in a desktop chat tab (T-63 round 5), only while Profiles is on: in a Session's
 * chat (a Session with no profile shows the agent's mark) and in any tab running a named profile.
 * Other chat tabs keep main's look.
 */
export function useChatPhoto(state: ChatPanelState | undefined): ChatPhoto | undefined {
  const on = useConfigStore(store => isProfilesEnabled(store.config));
  const current = state ? launchProfileRef(state.agent, state.launch) : undefined;
  const named = state?.launch.kind === 'profile' && !plainProfileAgent(state.launch.profile);
  const shown = on && !!state && (!!state.orchestrationSessionId || named);
  return useMemo(() => shown ? { current, avatar, heading: current ? <ChatProfileHeading profile={current} /> : null } : undefined, [current, shown]);
}
