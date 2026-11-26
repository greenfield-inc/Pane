import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bot, ChevronDown, ChevronRight, FileText, ImageIcon, Pencil, Pin, Plus, RefreshCw, RotateCcw, Sparkles, X } from 'lucide-react';
import { DEFAULT_AGENT_ID, agentLabel, configuredAgent } from '../../../../shared/agents';
import { plainProfileAgents } from '../../../../shared/agentProfiles';
import { MAX_PROFILE_PHOTO_BYTES, PROFILE_NAME_PATTERN, type ProfileNewFileKind, type ProfilePlugin, type ProfileSubagentNode, type ProfileSummary } from '../../../../shared/types/profileEditor';
import { isProfilesEnabled, useConfigStore } from '../../stores/configStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { profilePhotoSource, useProfilesStore } from '../../stores/profilesStore';
import { usePausableDismiss } from '../../hooks/usePausableDismiss';
import { cn } from '../../utils/cn';
import { requestOpenSettings } from '../../utils/openSettings';
import { profileDisplayName } from '../../utils/profileAvatar';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Dropdown } from '../ui/Dropdown';
import { ConfirmDialog } from '../ConfirmDialog';
import { isTypingTarget, overlayOpen } from '../todos/todosNavigation';
import { TODOS_HEADER_BUTTON, TODOS_PILL, TODOS_PILL_OFF } from '../todos/todoStyles';
import { ProfileAvatar } from './ProfileAvatar';
import { ProfileFilePane } from './ProfileFilePane';
import { ProfileTree } from './ProfileTree';
import { isPinned, pinnedFirst, togglePinnedProfile, usePinnedProfiles } from './profilePins';
import { PHOTO_ACCEPT, PHOTO_SAMPLES, readSvgPhoto } from './profilePhotos';
import { leaveProfiles } from './profilesNavigation';
import { directSubagents } from './profilePreview';
import { openSubagentTab } from './subagentTab';
import { syncFooterText, syncNowText, syncStateText } from './profileSyncText';
import { MachineMark } from '../machines/MachineMark';
import { useAllMachinesStore } from '../../stores/allMachinesStore';
import { machineLetter } from '../../../../shared/utils/machineMarks';

/** How often the open tab looks for changes made outside it. */
const PROFILES_REFRESH_MS = 3000;

/** Sync (PR 6) follows the Profiles switch (D-474): off, no Sync button, sync line or sync wording. */
function useSyncOn(): boolean {
  return useConfigStore(state => isProfilesEnabled(state.config));
}

/** The words a notice adds when a change also goes to your other computers. */
function elsewhere(): string {
  return isProfilesEnabled(useConfigStore.getState().config) ? ' It goes to your other computers too.' : '';
}

/** How many Sessions on this computer use each profile (`plugin/profile`, variant left out). */
function useSessionsByProfile(): Map<string, number> {
  const sessions = useOrchestrationSessionStore(state => state.sessions);
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (session.archived || !session.agentProfile) continue;
      const ref = session.agentProfile.ref.split(':')[0];
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
    return counts;
  }, [sessions]);
}

/** A profile's name as people see it: its title from Edit details, else the one Pane makes from its ref. */
function titleOf(profile: ProfileSummary): string {
  return profile.title ?? profileDisplayName(profile.ref);
}

/** The agents a profile runs on: "Claude or Codex" for one with both variants, else its harness. */
function runsOn(profile: ProfileSummary): string {
  return profile.variants?.length ? profile.variants.map(agentLabel).join(' or ') : agentLabel(profile.harness);
}

/** How many agents a profile links to directly. */
function subagentCount(profile: ProfileSummary): number {
  return directSubagents(profile.tree).length;
}

/** A short notice at the bottom of the tab, which fades after a few seconds unless hovered. */
function Notice({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  const pause = usePausableDismiss(onDismiss, 6000);
  return (
    <div role="status" {...pause} data-testid="profiles-notice" className="fixed bottom-12 left-1/2 z-50 max-w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 rounded-md border border-border-primary bg-surface-primary px-3 py-2 text-[13px] text-text-primary shadow-dropdown">
      {text}
    </div>
  );
}

/** Moves focus between the `[data-profiles-item]` buttons of a list with ↑ and ↓. */
function arrowKeys(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-profiles-item]')];
  if (!items.length) return;
  event.preventDefault();
  const index = items.findIndex(item => item === document.activeElement);
  const next = event.key === 'ArrowDown' ? items[(index + 1) % items.length] : items[(index - 1 + items.length) % items.length];
  next.focus();
}

/** Pin or unpin a profile; pinned ones lead the list and New Session. */
function PinButton({ profile, pinned, className }: { profile: ProfileSummary; pinned: boolean; className?: string }) {
  const label = `${pinned ? 'Unpin' : 'Pin'} ${titleOf(profile)}`;
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={label}
      title={pinned ? 'Unpin' : 'Pin to the top of Profiles and New Session'}
      data-testid={`profile-pin-${profile.ref}`}
      onClick={event => { event.stopPropagation(); togglePinnedProfile(profile.ref); }}
      className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-surface-tertiary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive', pinned ? 'text-interactive' : 'text-text-tertiary', className)}
    >
      <Pin className={cn('h-3.5 w-3.5', pinned && 'fill-current')} aria-hidden="true" />
    </button>
  );
}

/**
 * Profiles (T-63 PR 5, design round 4 "Tree + preview"): this computer's top-level Agent Farm
 * profiles, pinned first. A profile opens on its cover page, with only its own files in a tree
 * beside it, previewed first and edited with Edit. Save checks the plugin with Agent Farm; Sessions
 * using it then show the changed dot. Pane's own profiles can be edited, become "Edited", and
 * Restore brings Pane's version back (A-3). Esc or ⌘[ goes back.
 */
export function ProfilesView() {
  const place = useProfilesStore(state => state.place);
  const overview = useProfilesStore(state => state.overview);
  const loading = useProfilesStore(state => state.loading);
  const error = useProfilesStore(state => state.error);
  const load = useProfilesStore(state => state.load);
  const back = useProfilesStore(state => state.back);
  const [notice, setNotice] = useState<{ key: number; text: string } | null>(null);
  const notify = useCallback((text: string) => setNotice({ key: Date.now(), text }), []);
  const [creating, setCreating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const loadSync = useProfilesStore(state => state.loadSync);
  const follow = useProfilesStore(state => state.follow);
  const syncOn = useSyncOn();

  useEffect(() => { void load(); }, [load]);
  // Saves sync to your other computers: the footer follows each sync, and saves that arrive show here.
  useEffect(() => {
    if (!syncOn) return undefined;
    void loadSync();
    return follow();
  }, [follow, loadSync, syncOn]);

  // Changes made outside the tab (an agent, `runpane profiles`, sync from another computer) show
  // within a few seconds: while the tab is visible it reads the list and the open file again, and at
  // once when the window regains focus. Both are local file reads; Agent Farm is asked which
  // profiles are listed only when a profile file changed.
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') void useProfilesStore.getState().refresh(); };
    const timer = window.setInterval(refresh, PROFILES_REFRESH_MS);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  const plugin = place.level === 'profile' ? overview?.plugins.find(entry => entry.name === place.plugin) : undefined;
  const profile = place.level === 'profile' ? plugin?.profiles.find(entry => entry.name === place.profile) : undefined;
  // A profile that went away (restored without it, or removed on disk) returns to the list.
  useEffect(() => { if (place.level === 'profile' && overview && !profile) back(); }, [back, overview, place.level, profile]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || overlayOpen()) return;
      const goBack = event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key === '[');
      if (!goBack) return;
      // Esc in the editor cancels the edit first (ProfileFilePane); typing elsewhere keeps its keys.
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      if (useProfilesStore.getState().place.level === 'profile') back();
      else leaveProfiles();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [back]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-primary text-[14px] text-text-primary" data-testid="profiles-view">
      {plugin && profile && place.level === 'profile'
        ? <ProfileDetail key={profile.ref} plugin={plugin} profile={profile} file={place.file} notify={notify} />
        : (
          <>
            <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-border-primary px-4">
              <h1 className="shrink-0 whitespace-nowrap text-[15px] font-semibold">Profiles</h1>
              {overview && <span className="truncate text-[12px] text-text-tertiary" data-testid="profiles-machine">on {overview.machine}</span>}
              <span className="flex-1" />
              {syncOn && (
                <button
                  type="button"
                  className={TODOS_HEADER_BUTTON}
                  data-testid="profiles-sync"
                  title="Send every profile to your other computers now"
                  onClick={() => setSyncing(true)}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Sync
                </button>
              )}
              <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-new" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />New profile
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {error && <p role="alert" className="mx-auto mt-6 max-w-[820px] px-6 text-[13px] text-status-error">{error}</p>}
              {overview?.error && <p role="alert" className="mx-auto mt-6 max-w-[820px] px-6 text-[13px] text-status-warning">{overview.error}</p>}
              {!overview && loading && <p className="mx-auto mt-6 max-w-[820px] px-6 text-[13px] text-text-tertiary">Reading profiles…</p>}
              {overview && <ProfileList plugins={overview.plugins} />}
            </div>
          </>
        )}
      <ProfilesFooter />
      {creating && <NewProfileDialog onClose={() => setCreating(false)} notify={notify} />}
      {syncing && syncOn && <SyncSheet onClose={() => setSyncing(false)} notify={notify} />}
      {notice && <Notice key={notice.key} text={notice.text} onDismiss={() => setNotice(null)} />}
    </div>
  );
}

function ProfileRow({ plugin, profile, pinned, sessions, first }: { plugin: ProfilePlugin; profile: ProfileSummary; pinned: boolean; sessions: number; first: boolean }) {
  const open = useProfilesStore(state => state.open);
  const subagents = subagentCount(profile);
  const meta = [subagents ? `${subagents} subagent${subagents === 1 ? '' : 's'}` : '', sessions ? `${sessions} Session${sessions === 1 ? '' : 's'}` : '', runsOn(profile)].filter(Boolean).join(' · ');
  return (
    <div role="listitem" className="group relative flex items-center rounded-lg hover:bg-surface-hover focus-within:bg-surface-hover">
      <button
        type="button"
        data-profiles-item
        // Keyboard focus arriving from the sidebar (Enter on Profiles) lands on the first profile.
        data-focus-entry={first ? '' : undefined}
        data-testid={`profile-row-${plugin.name}-${profile.name}`}
        onClick={() => open(plugin.name, profile.name)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-[7px] pl-2 pr-[72px] text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive"
      >
        <ProfileAvatar profileRef={profile.ref} size={30} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13.5px] font-medium text-text-primary">{titleOf(profile)}</span>
            {plugin.edited && <span className="shrink-0 rounded-full border border-status-warning px-1.5 text-[10.5px] text-status-warning" data-testid={`profiles-edited-${plugin.name}`}>Edited</span>}
          </span>
          <span className="truncate text-[12px] text-text-tertiary">{profile.ref}{profile.description ? ` · ${profile.description}` : ''}</span>
        </span>
        <span className="shrink-0 whitespace-nowrap text-[12.5px] text-text-secondary">{meta}</span>
      </button>
      <PinButton profile={profile} pinned={pinned} className={cn('absolute right-8', !pinned && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')} />
      <ChevronRight className="pointer-events-none absolute right-2.5 h-4 w-4 text-text-tertiary" aria-hidden="true" />
    </div>
  );
}

/**
 * The list (build-6 feedback items 1 and 2): every profile Agent Farm lists (T-83: the helpers a
 * profile starts are agents in its tree, not profiles), with pinned ones first.
 */
function ProfileList({ plugins }: { plugins: ProfilePlugin[] }) {
  const used = useSessionsByProfile();
  const pins = usePinnedProfiles();
  const listRef = useRef<HTMLDivElement>(null);
  const all = plugins.flatMap(plugin => plugin.profiles.map(profile => ({ plugin, profile })));
  const pinned = pinnedFirst(all.filter(item => isPinned(pins, item.profile.ref)), pins, item => item.profile.ref);
  const rest = all.filter(item => !isPinned(pins, item.profile.ref));
  // Keys belong to the list once it is open: the first profile takes focus.
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('[data-profiles-item]')?.focus({ preventScroll: true }); }, []);
  if (!all.length) {
    return <p className="mx-auto mt-8 max-w-[820px] px-6 text-[13px] text-text-secondary">No profiles here yet. Use New profile to make one.</p>;
  }
  const first = (pinned[0] ?? rest[0])?.profile.ref;
  const row = ({ plugin, profile }: { plugin: ProfilePlugin; profile: ProfileSummary }) => (
    <ProfileRow key={profile.ref} plugin={plugin} profile={profile} pinned={isPinned(pins, profile.ref)} sessions={used.get(profile.ref) ?? 0} first={profile.ref === first} />
  );
  return (
    <div ref={listRef} role="list" aria-label="Profiles" className="mx-auto max-w-[820px] px-6 pb-8 pt-4" onKeyDown={arrowKeys} data-testid="profiles-list">
      {pinned.length > 0 && (
        <>
          <div role="presentation" className="mb-1 mt-3 flex items-center gap-1.5 px-2 text-[12.5px] font-semibold text-text-primary" data-testid="profiles-pinned-heading">
            <Pin className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />Pinned
          </div>
          {pinned.map(row)}
        </>
      )}
      <div role="presentation" className="mb-1 mt-5 flex items-center gap-1.5 px-2 text-[12.5px]" data-testid="profiles-all-heading">
        <span className="font-semibold text-text-primary">{pinned.length ? 'All profiles' : 'Profiles'}</span>
        <span className="text-text-tertiary">· {rest.length}</span>
      </div>
      {rest.map(row)}
    </div>
  );
}

function ProfilesFooter() {
  const overview = useProfilesStore(state => state.overview);
  const sync = useProfilesStore(state => state.sync);
  const syncOn = useSyncOn();
  const telemetry = useConfigStore(state => state.config?.agentFarmTelemetry === true);
  const used = useSessionsByProfile();
  if (!overview) return null;
  const profiles = overview.plugins.reduce((total, plugin) => total + plugin.profiles.length, 0);
  const known = new Set(overview.plugins.flatMap(plugin => plugin.profiles.map(profile => profile.ref)));
  const sessions = [...used].filter(([ref]) => known.has(ref)).reduce((total, [, count]) => total + count, 0);
  return (
    <div className="flex h-[34px] shrink-0 items-center gap-4 border-t border-border-primary px-4 text-[12px] text-text-secondary" data-testid="profiles-footer">
      <span>{profiles} profile{profiles === 1 ? '' : 's'} · {sessions} Session{sessions === 1 ? ' uses' : 's use'} one</span>
      {syncOn && <span className="truncate text-text-tertiary" data-testid="profiles-sync-status">{syncFooterText(sync)}</span>}
      <span className="ml-auto shrink-0">
        Agent Farm telemetry: {telemetry ? 'on' : 'off'} ·{' '}
        <button type="button" className="text-interactive hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive" onClick={() => requestOpenSettings({ category: 'ai-agents', setting: 'agent-farm-telemetry' })}>Settings</button>
      </span>
    </div>
  );
}

function ProfileDetail({ plugin, profile, file, notify }: { plugin: ProfilePlugin; profile: ProfileSummary; file: string; notify: (text: string) => void }) {
  const back = useProfilesStore(state => state.back);
  const restore = useProfilesStore(state => state.restore);
  const openFile = useProfilesStore(state => state.openFile);
  const pins = usePinnedProfiles();
  const [newKind, setNewKind] = useState<ProfileNewFileKind | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [details, setDetails] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const show = (id: string | null, next: string) => {
    setSelectedId(id);
    openFile(next);
  };

  // Opens a launch or process agent in a tab of the Pane you came from (T-83 P4); a reason it didn't shows as a notice.
  const openTab = (node: ProfileSubagentNode) => {
    void openSubagentTab(node).then(reason => { if (reason) notify(reason); });
  };

  const runRestore = async () => {
    try {
      await restore(plugin.name);
      notify(`Restored Pane's ${plugin.name}${isProfilesEnabled(useConfigStore.getState().config) ? ', here and on your other computers' : ''}. Sessions using it can reload it.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <div className="flex h-[54px] shrink-0 items-center gap-2.5 border-b border-border-primary px-4">
        <button type="button" className={cn(TODOS_PILL, TODOS_PILL_OFF)} data-testid="profiles-back" title="Back to Profiles (Esc)" onClick={back}>‹ Profiles</button>
        <PhotoMenu profile={profile} notify={notify} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[15px] font-semibold" data-testid="profiles-title">{titleOf(profile)}</span>
          <span className="truncate text-[11.5px] text-text-tertiary" data-testid="profiles-subtitle">
            {profile.ref}{profile.description ? ` · ${profile.description}` : ` · ${runsOn(profile)}`}{plugin.bundled ? ` · ships with Pane${plugin.edited ? ', edited' : ''}` : ''}
          </span>
        </span>
        <PinButton profile={profile} pinned={isPinned(pins, profile.ref)} />
        <span className="flex-1" />
        <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-edit-details" onClick={() => setDetails(true)}>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit details
        </button>
        <Dropdown
          trigger={(
            <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-add">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />New<ChevronDown className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
            </button>
          )}
          items={[
            { id: 'subagent', label: 'New subagent', icon: Bot, description: 'agents/', onClick: () => setNewKind('subagent') },
            { id: 'skill', label: 'New skill', icon: Sparkles, description: 'skills/', onClick: () => setNewKind('skill') },
            { id: 'reference', label: 'New reference', icon: FileText, description: 'references/', onClick: () => setNewKind('reference') },
          ]}
          position="bottom-right"
          width="md"
          menuLabel="New"
        />
        {plugin.bundled && plugin.edited && (
          <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-restore" onClick={() => setRestoring(true)}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Restore Pane’s version
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <ProfileTree plugin={plugin.name} profile={profile} file={file} selectedId={selectedId} onSelect={show} onOpenTab={openTab} />
        <ProfileFilePane plugin={plugin} profile={profile} file={file} notify={notify} onShow={show} onOpenTab={openTab} />
      </div>
      {newKind && <NewFileDialog kind={newKind} plugin={plugin} profile={profile} onClose={() => setNewKind(null)} notify={notify} onCreated={path => show(null, path)} />}
      {details && <EditDetailsDialog plugin={plugin} profile={profile} onClose={() => setDetails(false)} notify={notify} />}
      <ConfirmDialog
        isOpen={restoring}
        onClose={() => setRestoring(false)}
        onConfirm={() => { void runRestore(); }}
        title={`Restore Pane’s ${plugin.name}?`}
        message={`Your edits to ${plugin.name} are replaced by the version that ships with this Pane (${plugin.version}). Your photos, titles and descriptions stay.`}
        confirmText="Restore"
        variant="danger"
      />
    </>
  );
}

/**
 * Edit details (build-6 feedback item 6, T-83): a profile's photo, title and description, which
 * Agent Farm owns. Saving goes through `agent-farm profiles set`, kept by Agent Farm on this
 * computer apart from the plugin, so it survives Pane updates and never marks a plugin Edited. An
 * empty title or description goes back to the plugin's own; removing your photo shows the plugin's.
 */
function EditDetailsDialog({ plugin, profile, onClose, notify }: { plugin: ProfilePlugin; profile: ProfileSummary; onClose: () => void; notify: (text: string) => void }) {
  const setProfileDetails = useProfilesStore(state => state.setDetails);
  const photos = useProfilesStore(state => state.photos);
  const setPhoto = useProfilesStore(state => state.setPhoto);
  const removePhoto = useProfilesStore(state => state.removePhoto);
  const [title, setTitle] = useState(profile.title ?? '');
  const [description, setDescription] = useState(profile.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ownPhoto = profilePhotoSource(photos, profile.ref) === 'yours';

  const upload = (chosen: File) => {
    setError(null);
    readSvgPhoto(chosen).then(svg => setPhoto(profile.ref, svg))
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setProfileDetails(plugin.name, profile.name, { title, description });
      notify(`Saved ${title.trim() || titleOf(profile)}’s details.`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="md" ariaLabel="Edit details" initialFocusRef={titleRef}>
      <form className="p-6 pt-2" onSubmit={event => { event.preventDefault(); void submit(); }} data-testid="profiles-details-dialog">
        <h3 className="mb-4 text-lg font-medium text-text-primary">Edit details</h3>
        <div className="mb-4 flex items-center gap-3">
          <ProfileAvatar profileRef={profile.ref} agent={profile.harness} size={56} />
          <input ref={fileRef} type="file" accept={PHOTO_ACCEPT} className="hidden" data-testid="profiles-details-photo-file"
            onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ''; if (chosen) upload(chosen); }} />
          <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-details-upload" onClick={() => fileRef.current?.click()}>
            <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />Upload SVG…
          </button>
          <button type="button" className="rounded px-2 py-1 text-[13px] text-text-secondary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive disabled:opacity-50"
            data-testid="profiles-details-initials" disabled={!ownPhoto} title="The plugin’s own photo shows again, or initials when it has none"
            onClick={() => { removePhoto(profile.ref).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))); }}>
            Remove my photo
          </button>
        </div>
        <label className="mb-1 block text-[12.5px] font-medium text-text-primary" htmlFor="profiles-details-title">Title</label>
        <input id="profiles-details-title" ref={titleRef} value={title} onChange={event => setTitle(event.target.value)} placeholder={profileDisplayName(profile.ref)} autoComplete="off"
          className="mb-3 h-8 w-full rounded-md border border-border-primary bg-surface-primary px-2.5 text-[13px] text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive" />
        <label className="mb-1 block text-[12.5px] font-medium text-text-primary" htmlFor="profiles-details-description">Description</label>
        <textarea id="profiles-details-description" value={description} onChange={event => setDescription(event.target.value)} rows={3}
          className="mb-2 w-full rounded-md border border-border-primary bg-surface-primary px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive" />
        <p className="mb-4 text-[12px] text-text-secondary">
          Agent Farm keeps the title, description and photo on this computer, apart from {plugin.name}’s files, so they survive Pane updates. Leave a box empty to use the plugin’s own. A photo is an SVG file of at most {MAX_PROFILE_PHOTO_BYTES / 1024} KiB.
        </p>
        {error && <p role="alert" className="mb-3 text-[12.5px] text-status-error">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={busy} data-testid="profiles-details-save">{busy ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function PhotoMenu({ profile, notify }: { profile: ProfileSummary; notify: (text: string) => void }) {
  const photos = useProfilesStore(state => state.photos);
  const setPhoto = useProfilesStore(state => state.setPhoto);
  const removePhoto = useProfilesStore(state => state.removePhoto);
  const source = profilePhotoSource(photos, profile.ref);
  const fileRef = useRef<HTMLInputElement>(null);

  /** Sends an SVG's text; Agent Farm checks it, and its reason shows when it refuses. */
  const apply = async (svg: string | Promise<string>, done: string) => {
    try {
      await setPhoto(profile.ref, await svg);
      notify(done);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept={PHOTO_ACCEPT}
        className="hidden"
        data-testid="profile-photo-file"
        onChange={event => {
          const chosen = event.target.files?.[0];
          event.target.value = '';
          if (chosen) void apply(readSvgPhoto(chosen), `Photo set.${elsewhere()}`);
        }}
      />
      <Dropdown
        trigger={(
          <button type="button" className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive" data-testid="profile-photo" title="Change photo" aria-label={`Photo of ${titleOf(profile)}`}>
            <ProfileAvatar profileRef={profile.ref} agent={profile.harness} size={30} />
          </button>
        )}
        header={(
          <div className="pb-1">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
              {source === 'yours' ? 'Your photo' : source === 'plugin' ? 'Photo from the plugin' : 'Generated from the name'}
            </div>
            <div className="mt-2 flex gap-4 normal-case tracking-normal">
              <span className="flex flex-col items-center gap-1 text-[11px] text-text-tertiary"><ProfileAvatar profileRef={profile.ref} size={44} />Now</span>
              <span className="flex flex-col items-center gap-1 text-[11px] text-text-tertiary"><ProfileAvatar profileRef={profile.ref} size={44} generated />Generated</span>
            </div>
          </div>
        )}
        items={[
          { id: 'choose', label: 'Choose SVG…', icon: ImageIcon, onClick: () => fileRef.current?.click() },
          {
            id: 'remove',
            label: 'Remove my photo',
            icon: X,
            disabled: source !== 'yours',
            onClick: () => {
              removePhoto(profile.ref).then(() => notify('Photo removed. The plugin’s own photo shows, or initials when it has none.'), error => notify(error instanceof Error ? error.message : String(error)));
            },
          },
        ]}
        footer={({ close }) => (
          <div className="flex gap-1.5 px-2 py-2" role="group" aria-label="Sample photos">
            {PHOTO_SAMPLES.map(sample => (
              <button
                key={sample.id}
                type="button"
                title={sample.label}
                aria-label={`Use sample: ${sample.label}`}
                data-testid={`profile-photo-sample-${sample.id}`}
                onClick={() => { close(); void apply(sample.svg, `Photo set.${elsewhere()}`); }}
                className="h-7 w-7 overflow-hidden rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive"
              >
                <img src={sample.src} alt="" className="h-full w-full" />
              </button>
            ))}
          </div>
        )}
        position="bottom-left"
        width="md"
        menuLabel="Profile photo"
      />
    </>
  );
}

function nameProblem(name: string): string | null {
  if (!name) return null;
  return PROFILE_NAME_PATTERN.test(name) ? null : 'Use lowercase letters, digits, - and _, starting with a letter.';
}

/** Sync now (the chosen design): each computer's state, and a button that sends every profile again. */
function SyncSheet({ onClose, notify }: { onClose: () => void; notify: (text: string) => void }) {
  const sync = useProfilesStore(state => state.sync);
  const syncNow = useProfilesStore(state => state.syncNow);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const computers = sync?.computers ?? [];
  // Each computer's mark as the sidebar draws it; one the sidebar hasn't listed takes its letter and the next colour.
  const entries = useAllMachinesStore(state => state.entries);
  const mark = (key: string, name: string, index: number) => {
    const entry = entries.find(item => item.id === key);
    return entry ? { letters: entry.letters, slot: entry.slot } : { letters: machineLetter(name), slot: (index + 1) % 6 };
  };

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      notify(syncNowText(await syncNow()));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="md" ariaLabel="Sync profiles now" initialFocusRef={confirmRef}>
      <div className="p-6 pt-2" data-testid="profiles-sync-sheet">
        <h3 className="mb-2 text-lg font-medium text-text-primary">Sync profiles now</h3>
        <p className="mb-4 text-[13px] leading-relaxed text-text-secondary">
          Pane already pushes every profile save from this computer to your others. Sync now sends all profiles again, for example after a computer was away for a long time. The newest save of each profile wins.
        </p>
        {computers.length
          ? (
            <table className="mb-4 w-full border-collapse text-[13px]" data-testid="profiles-sync-table">
              <thead>
                <tr className="border-b border-border-primary text-left text-[12px] text-text-tertiary">
                  <th className="py-1.5 pr-3 font-medium">Computer</th>
                  <th className="py-1.5 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {computers.map((computer, index) => (
                  <tr key={`${computer.id}:${computer.name}`} className="border-b border-border-primary last:border-b-0" data-testid={`profiles-sync-row-${computer.name}`}>
                    <td className="py-2 pr-3 align-top text-text-primary">
                      <span className="inline-flex items-center gap-2"><MachineMark {...mark(computer.key, computer.name, index)} size="logo" />{computer.name}</span>
                    </td>
                    <td className={cn('py-2 align-top', computer.state === 'failed' || computer.state === 'outdated' ? 'text-status-warning' : 'text-text-secondary')}>{syncStateText(computer)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
          : <p className="mb-4 text-[13px] text-text-secondary">No other computers are linked to this one, so there is nothing to sync with.</p>}
        {error && <p role="alert" className="mb-3 text-[12.5px] text-status-error">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button ref={confirmRef} type="button" onClick={() => { void run(); }} disabled={busy || !computers.length} data-testid="profiles-sync-now">{busy ? 'Syncing…' : 'Sync now'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function NewProfileDialog({ onClose, notify }: { onClose: () => void; notify: (text: string) => void }) {
  const newProfile = useProfilesStore(state => state.newProfile);
  const open = useProfilesStore(state => state.open);
  const machine = useProfilesStore(state => state.overview?.machine);
  const agents = plainProfileAgents();
  const [name, setName] = useState('');
  const [agent, setAgent] = useState<string>(agents[0] ?? DEFAULT_AGENT_ID);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const problem = nameProblem(name);

  const create = async () => {
    if (!name || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await newProfile(name, agent);
      // A new profile opens on its cover page, like any other.
      open(result.plugin.name, result.plugin.profiles[0]?.name ?? name);
      notify(`Created ${name}.`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="sm" ariaLabel="New profile" initialFocusRef={inputRef}>
      <form className="p-6 pt-2" onSubmit={event => { event.preventDefault(); void create(); }} data-testid="profiles-new-dialog">
        <h3 className="mb-1 text-lg font-medium text-text-primary">New profile</h3>
        <p className="mb-4 text-[13px] text-text-secondary">An Agent Farm plugin{machine ? ` on ${machine}` : ''} with one profile and its identity file.</p>
        <label className="mb-1 block text-[12.5px] font-medium text-text-primary" htmlFor="profiles-new-name">Name</label>
        <input id="profiles-new-name" ref={inputRef} value={name} onChange={event => setName(event.target.value.trim())} placeholder="researcher" autoComplete="off"
          className="mb-1 h-8 w-full rounded-md border border-border-primary bg-surface-primary px-2.5 text-[13px] text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive" />
        <p className="mb-3 min-h-[18px] text-[12px] text-status-error">{problem}</p>
        <label className="mb-1 block text-[12.5px] font-medium text-text-primary" htmlFor="profiles-new-agent">Runs on</label>
        <select id="profiles-new-agent" value={agent} onChange={event => setAgent(event.target.value)}
          className="mb-4 h-8 w-full rounded-md border border-border-primary bg-surface-primary px-2 text-[13px] text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive">
          {agents.map(id => <option key={id} value={id}>{agentLabel(id)} · {configuredAgent(id).chat?.profileModel}</option>)}
        </select>
        {error && <p role="alert" className="mb-3 text-[12.5px] text-status-error">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!name || !!problem || busy} data-testid="profiles-new-create">{busy ? 'Creating…' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}

const NEW_FILE_TEXT = {
  subagent: { title: 'New subagent', placeholder: 'researcher' },
  skill: { title: 'New skill', placeholder: 'weekly-recap' },
  reference: { title: 'New reference', placeholder: 'style-guide' },
} satisfies Record<ProfileNewFileKind, { title: string; placeholder: string }>;

function NewFileDialog({ kind, plugin, profile, onClose, notify, onCreated }: { kind: ProfileNewFileKind; plugin: ProfilePlugin; profile: ProfileSummary; onClose: () => void; notify: (text: string) => void; onCreated: (path: string) => void }) {
  const newFile = useProfilesStore(state => state.newFile);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const problem = nameProblem(name);
  const text = NEW_FILE_TEXT[kind];
  const where = kind === 'skill' ? 'skills/<name>/SKILL.md' : kind === 'subagent' ? 'agents/<name>.md' : 'references/…/<name>.md';
  const adds = kind === 'skill' ? `adds it to ${profile.name}’s skills` : kind === 'subagent' ? `adds it to ${profile.name}’s subagents` : `adds it to ${profile.name}’s references`;

  const create = async () => {
    if (!name || problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await newFile(plugin.name, profile.name, kind, name);
      onCreated(result.path);
      notify(`Created ${plugin.name}/${result.path}.`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} size="sm" ariaLabel={text.title} initialFocusRef={inputRef}>
      <form className="p-6 pt-2" onSubmit={event => { event.preventDefault(); void create(); }} data-testid="profiles-new-file-dialog">
        <h3 className="mb-4 text-lg font-medium text-text-primary">{text.title}</h3>
        <label className="mb-1 block text-[12.5px] font-medium text-text-primary" htmlFor="profiles-new-file-name">Name</label>
        <input id="profiles-new-file-name" ref={inputRef} value={name} onChange={event => setName(event.target.value.trim())} placeholder={text.placeholder} autoComplete="off"
          className="mb-1 h-8 w-full rounded-md border border-border-primary bg-surface-primary px-2.5 text-[13px] text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive" />
        <p className="mb-2 min-h-[18px] text-[12px] text-status-error">{problem}</p>
        <p className="mb-4 text-[12px] text-text-secondary">Creates {plugin.name}/{where} and {adds}, then checks the plugin with Agent Farm.</p>
        {error && <p role="alert" className="mb-3 text-[12.5px] text-status-error">{error}</p>}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!name || !!problem || busy} data-testid="profiles-new-file-create">{busy ? 'Creating…' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}
