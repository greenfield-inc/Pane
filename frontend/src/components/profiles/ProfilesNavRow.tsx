import { UserCheck } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useNavigationStore } from '../../stores/navigationStore';
import { isProfilesEnabled, useConfigStore } from '../../stores/configStore';
import { toggleProfiles } from './profilesNavigation';

/** The sidebar row classes ProjectSessionList's other entries use (Loops, Approvals, To-dos). */
const ROW = 'mx-2 flex w-[calc(100%-1rem)] items-center gap-2 px-2 text-left transition-colors h-7 rounded-md text-[13px] hover:bg-surface-hover hover:text-text-primary';

/**
 * Profiles (T-63), under To-dos: opens the Profiles tab, and clicked again returns to the view you
 * left. Desktop only, and only with the Profiles switch on (D-474); off, the sidebar is main's.
 */
export function ProfilesNavRow() {
  const open = useNavigationStore(state => state.activeView === 'profiles');
  const on = useConfigStore(state => isProfilesEnabled(state.config));
  if (!on || !window.electronAPI?.profiles) return null;
  return (
    <button
      type="button"
      data-testid="profiles-nav"
      data-sidebar-item
      data-sidebar-key="profiles"
      aria-pressed={open}
      aria-label="Profiles"
      title="Profiles"
      onClick={toggleProfiles}
      className={cn(ROW, open ? 'bg-surface-hover text-text-primary' : 'text-text-secondary')}
    >
      <UserCheck className="h-3.5 w-3.5" aria-hidden="true" />
      <span>Profiles</span>
    </button>
  );
}

/** The compact rail's Profiles button. */
export function ProfilesRailButton({ buttonClass, activeClass, idleClass }: { buttonClass: string; activeClass: string; idleClass: string }) {
  const open = useNavigationStore(state => state.activeView === 'profiles');
  const on = useConfigStore(state => isProfilesEnabled(state.config));
  if (!on || !window.electronAPI?.profiles) return null;
  return (
    <button type="button" data-testid="compact-profiles" data-compact-rail-item onClick={toggleProfiles} aria-pressed={open} aria-label="Profiles" className={`${buttonClass} ${open ? activeClass : idleClass}`}>
      <UserCheck className="h-4 w-4" />
    </button>
  );
}
