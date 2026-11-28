import type { ReactNode } from 'react';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import type { ToolPanel } from '../../../../shared/types/panels';
import { ProfileAvatar } from '../profiles/ProfileAvatar';
import { useChatPhoto } from './useChatPhoto';

/**
 * A chat tab's icon (T-63 round 5): its profile's photo in place of the agent mark, for a Session's
 * chat or a tab running a named profile, while Profiles is on; otherwise `fallback`, main's icon.
 */
export function ChatTabIcon({ panel, size, fallback }: { panel: ToolPanel; size: number; fallback: ReactNode }) {
  // SAFETY: only chat panels are drawn with this icon, and the panel type 'chat' carries ChatPanelState as its custom state.
  const state = panel.state.customState as ChatPanelState | undefined;
  const photo = useChatPhoto(state);
  return photo?.current ? <ProfileAvatar profileRef={photo.current} agent={state?.agent} size={size} className="flex-shrink-0" /> : <>{fallback}</>;
}
