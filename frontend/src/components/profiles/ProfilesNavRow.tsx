import { useEffect } from 'react';
import { ChevronDown, Plus, UserCheck } from 'lucide-react';
import { cn } from '../../utils/cn';
import { profileDisplayName } from '../../utils/profileAvatar';
import { useNavigationStore } from '../../stores/navigationStore';
import { isProfilesEnabled, useConfigStore } from '../../stores/configStore';
import { useProfilesStore } from '../../stores/profilesStore';
import { ProfileAvatar } from './ProfileAvatar';
import { splitPinned, usePinnedProfiles } from './profilePins';
import { toggleProfiles } from './profilesNavigation';

/** The sidebar row classes ProjectSessionList's other entries use (Loops, Approvals, To-dos). */
const ROW = 'mx-2 flex w-[calc(100%-1rem)] items-center gap-2 px-2 text-left transition-colors h-7 rounded-md text-[13px] hover:bg-surface-hover hover:text-text-primary';

/** Whether Profiles shows in the sidebar: desktop only, with the Profiles switch on (D-474). */
function useProfilesShown(): boolean {
  const on = useConfigStore(state => isProfilesEnabled(state.config));
  return on && !!window.electronAPI?.profiles;
}

/**
 * Profiles (T-63), under To-dos: opens the Profiles tab, and clicked again returns to the view you
 * left. Desktop only, and only with the Profiles switch on (D-474); off, the sidebar is main's.
 */
export function ProfilesNavRow() {
  const open = useNavigationStore(state => state.activeView === 'profiles');
  if (!useProfilesShown()) return null;
  return (
    <button
      type="button"
      data-testid="profiles-nav"
      data-sidebar-item
      data-sidebar-key="profiles"
      // Not aria-expanded: the sidebar keeps focus on a toggle, and Enter here goes into Profiles.
      aria-pressed={open}
      aria-label="Profiles"
      title="Profiles"
      onClick={toggleProfiles}
      className={cn(ROW, open ? 'bg-surface-hover text-text-primary' : 'text-text-secondary')}
    >
      <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Profiles</span>
      {open && <ChevronDown className="ml-auto h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />}
    </button>
  );
}

/** One profile in the sidebar: its photo and name; clicking shows its cover in the Profiles tab. */
function SidebarProfileRow({ plugin, name, refName, title, pinned, selected }: { plugin: string; name: string; refName: string; title?: string; pinned: boolean; selected: boolean }) {
  const label = title ?? profileDisplayName(refName);
  return (
    <button
      type="button"
      data-sidebar-item
      data-sidebar-key={`profile:${refName}`}
      data-testid={`profiles-sidebar-${refName}`}
      aria-current={selected ? 'page' : undefined}
      title={`${label} · ${refName}`}
      onClick={() => useProfilesStore.getState().open(plugin, name)}
      className={cn(ROW, 'pl-[30px]', selected ? 'bg-surface-hover text-text-primary' : 'text-text-secondary')}
    >
      <ProfileAvatar profileRef={refName} size={16} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {pinned && <span className="shrink-0 text-[11px] text-text-tertiary">pinned</span>}
    </button>
  );
}

/**
 * The profiles under the Profiles row while the tab is open (T-63 round 5, layout (a)), the way
 * To-dos lists its items: pinned first, then the rest, then New profile. Clicking one shows its
 * cover; the Sessions and Projects below move down while it is open and come back when you leave.
 */
export function ProfilesSidebarSection() {
  const open = useNavigationStore(state => state.activeView === 'profiles');
  const shown = useProfilesShown();
  const overview = useProfilesStore(state => state.overview);
  const place = useProfilesStore(state => state.place);
  const pins = usePinnedProfiles();
  const visible = open && shown;
  // The tab reads the list as it opens; this covers a section drawn first.
  useEffect(() => { if (visible && !useProfilesStore.getState().overview) void useProfilesStore.getState().load(); }, [visible]);
  if (!visible) return null;
  const { pinned, rest } = splitPinned(overview?.plugins ?? [], pins);
  const row = ({ plugin, profile }: (typeof pinned)[number], isPinned: boolean) => (
    <SidebarProfileRow
      key={profile.ref}
      plugin={plugin.name}
      name={profile.name}
      refName={profile.ref}
      title={profile.title}
      pinned={isPinned}
      selected={place.level === 'profile' && place.plugin === plugin.name && place.profile === profile.name}
    />
  );
  return (
    <div role="group" aria-label="Profiles" data-testid="profiles-sidebar">
      {pinned.map(item => row(item, true))}
      {pinned.length > 0 && rest.length > 0 && <div role="presentation" className="my-1 ml-[30px] mr-4 border-t border-border-primary" />}
      {rest.map(item => row(item, false))}
      <button
        type="button"
        data-sidebar-item
        data-sidebar-key="profiles-new"
        data-testid="profiles-sidebar-new"
        onClick={() => useProfilesStore.getState().setCreating(true)}
        className={cn(ROW, 'pl-[30px] text-text-tertiary')}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        <span>New profile</span>
      </button>
    </div>
  );
}

/** The compact rail's Profiles button. */
export function ProfilesRailButton({ buttonClass, activeClass, idleClass }: { buttonClass: string; activeClass: string; idleClass: string }) {
  const open = useNavigationStore(state => state.activeView === 'profiles');
  if (!useProfilesShown()) return null;
  return (
    <button type="button" data-testid="compact-profiles" data-compact-rail-item onClick={toggleProfiles} aria-pressed={open} aria-label="Profiles" className={`${buttonClass} ${open ? activeClass : idleClass}`}>
      <UserCheck className="h-4 w-4" />
    </button>
  );
}
