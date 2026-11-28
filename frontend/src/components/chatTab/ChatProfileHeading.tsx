import { agentLabel } from '../../../../shared/agents';
import { plainProfileAgent } from '../../../../shared/agentProfiles';
import { useProfilesStore } from '../../stores/profilesStore';
import { profileDisplayName } from '../../utils/profileAvatar';

/** The current profile's name and ref at the top of a narrow chat: "Orchestrator greenfield/orchestrator". */
export function ChatProfileHeading({ profile }: { profile: string }) {
  const plain = plainProfileAgent(profile);
  const title = useProfilesStore(state => plain ? undefined : state.photos.titles[profile.split(':')[0]]);
  if (plain) return <span className="chat-header-who-name">{agentLabel(plain)}</span>;
  return <>
    <span className="chat-header-who-name">{title ?? profileDisplayName(profile)}</span>
    <span className="chat-header-who-ref" title={profile}>{profile}</span>
  </>;
}
