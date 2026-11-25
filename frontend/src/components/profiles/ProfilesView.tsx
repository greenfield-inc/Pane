import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Bot, ChevronDown, ChevronRight, FileText, Folder, ImageIcon, Plus, RefreshCw, RotateCcw, Save, Sparkles, X } from 'lucide-react';
import { DEFAULT_AGENT_ID, agentLabel, configuredAgent } from '../../../../shared/agents';
import { plainProfileAgents } from '../../../../shared/agentProfiles';
import { PROFILE_NAME_PATTERN, PROFILE_SYNC_AVAILABLE, type ProfileNewFileKind, type ProfilePlugin, type ProfileSummary } from '../../../../shared/types/profileEditor';
import { useConfigStore } from '../../stores/configStore';
import { useOrchestrationSessionStore } from '../../stores/orchestrationSessionStore';
import { fileKey, profilePhotoSource, useProfilesStore } from '../../stores/profilesStore';
import { usePausableDismiss } from '../../hooks/usePausableDismiss';
import { cn } from '../../utils/cn';
import { isMac } from '../../utils/platformUtils';
import { requestOpenSettings } from '../../utils/openSettings';
import { profileDisplayName } from '../../utils/profileAvatar';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Dropdown } from '../ui/Dropdown';
import { ConfirmDialog } from '../ConfirmDialog';
import { isTypingTarget, overlayOpen } from '../todos/todosNavigation';
import { TODOS_HEADER_BUTTON, TODOS_PILL, TODOS_PILL_OFF } from '../todos/todoStyles';
import { ProfileAvatar } from './ProfileAvatar';
import { fileTreeRows } from './profileFileTree';
import { PHOTO_SAMPLES, readFileAsDataUrl, squarePhoto } from './profilePhotos';
import { leaveProfiles } from './profilesNavigation';

const MOD = isMac() ? '⌘' : 'Ctrl+';
/** How often the open tab looks for changes made outside it. */
const PROFILES_REFRESH_MS = 3000;
const SYNC_LATER = 'Sync to your other computers arrives in the next update';

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

/**
 * Profiles (T-63 PR 5, the chosen design): this computer's Agent Farm profiles in one list, then a
 * profile's files with the open file beside them, and Back. Save checks the plugin with Agent Farm
 * first; Sessions using it then show the changed dot. Pane's own profiles can be edited, become
 * "Edited", and Restore brings Pane's version back (A-3). Esc or ⌘[ goes back; ⌘S saves.
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

  useEffect(() => { void load(); }, [load]);

  // Changes made outside the tab (an agent, `runpane profiles`, sync from another computer) show
  // within a few seconds: while the tab is visible it reads the list and the open file again, and at
  // once when the window regains focus. Both are local file reads, with no Agent Farm process.
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
      // Esc in the editor also goes back: unsaved edits stay, marked on their files.
      if (isTypingTarget(event.target) && !(event.target instanceof HTMLTextAreaElement)) return;
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
        ? <ProfileDetail plugin={plugin} profile={profile} file={place.file} notify={notify} />
        : (
          <>
            <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-border-primary px-4">
              <h1 className="shrink-0 whitespace-nowrap text-[15px] font-semibold">Profiles</h1>
              {overview && <span className="truncate text-[12px] text-text-tertiary" data-testid="profiles-machine">on {overview.machine}</span>}
              <span className="flex-1" />
              <button
                type="button"
                className={TODOS_HEADER_BUTTON}
                data-testid="profiles-sync"
                disabled={!PROFILE_SYNC_AVAILABLE}
                title={PROFILE_SYNC_AVAILABLE ? 'Send every profile to your other computers now' : SYNC_LATER}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />Sync
              </button>
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
      {notice && <Notice key={notice.key} text={notice.text} onDismiss={() => setNotice(null)} />}
    </div>
  );
}

function ProfileList({ plugins }: { plugins: ProfilePlugin[] }) {
  const open = useProfilesStore(state => state.open);
  const used = useSessionsByProfile();
  const listRef = useRef<HTMLDivElement>(null);
  // Keys belong to the list once it is open: the first profile takes focus.
  useEffect(() => { listRef.current?.querySelector<HTMLElement>('[data-profiles-item]')?.focus({ preventScroll: true }); }, []);
  if (!plugins.length) {
    return <p className="mx-auto mt-8 max-w-[820px] px-6 text-[13px] text-text-secondary">No profiles here yet. Use New profile to make one.</p>;
  }
  return (
    <div ref={listRef} role="list" aria-label="Profiles" className="mx-auto max-w-[820px] px-6 pb-8 pt-4" onKeyDown={arrowKeys} data-testid="profiles-list">
      {plugins.map(plugin => (
        <div key={plugin.name} role="presentation">
          <div className="mb-1 mt-5 flex items-center gap-2 px-2 text-[12.5px]" data-testid={`profiles-plugin-${plugin.name}`}>
            <span className="font-semibold text-text-primary">{plugin.name}</span>
            <span className="text-text-tertiary">{plugin.version}</span>
            {plugin.bundled && <span className="rounded-full border border-border-primary px-2 py-px text-[11px] text-text-secondary">Ships with Pane</span>}
            {plugin.edited && <span className="rounded-full border border-status-warning px-2 py-px text-[11px] text-status-warning" data-testid={`profiles-edited-${plugin.name}`}>Edited</span>}
          </div>
          {plugin.profiles.map(profile => {
            const count = used.get(profile.ref) ?? 0;
            return (
              <div key={profile.ref} role="listitem">
              <button
                type="button"
                data-profiles-item
                // Keyboard focus arriving from the sidebar (Enter on Profiles) lands on the first profile.
                data-focus-entry={plugin === plugins[0] && profile === plugin.profiles[0] ? '' : undefined}
                data-testid={`profile-row-${plugin.name}-${profile.name}`}
                onClick={() => open(plugin.name, profile.name)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-[7px] text-left hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive"
              >
                <ProfileAvatar profileRef={profile.ref} size={30} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13.5px] font-medium text-text-primary">{profileDisplayName(profile.ref)}</span>
                  <span className="truncate text-[12px] text-text-tertiary">{profile.ref}{profile.description ? ` · ${profile.description}` : ''}</span>
                </span>
                <span className="shrink-0 whitespace-nowrap text-[12.5px] text-text-secondary">
                  {count ? `${count} Session${count === 1 ? '' : 's'} · ` : ''}{agentLabel(profile.harness)}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
              </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ProfilesFooter() {
  const overview = useProfilesStore(state => state.overview);
  const telemetry = useConfigStore(state => state.config?.agentFarmTelemetry === true);
  const used = useSessionsByProfile();
  if (!overview) return null;
  const profiles = overview.plugins.reduce((total, plugin) => total + plugin.profiles.length, 0);
  const known = new Set(overview.plugins.flatMap(plugin => plugin.profiles.map(profile => profile.ref)));
  const sessions = [...used].filter(([ref]) => known.has(ref)).reduce((total, [, count]) => total + count, 0);
  return (
    <div className="flex h-[34px] shrink-0 items-center gap-4 border-t border-border-primary px-4 text-[12px] text-text-secondary" data-testid="profiles-footer">
      <span>{overview.plugins.length} plugin{overview.plugins.length === 1 ? '' : 's'} · {profiles} profile{profiles === 1 ? '' : 's'} · {sessions} Session{sessions === 1 ? ' uses' : 's use'} one</span>
      <span className="truncate text-text-tertiary" data-testid="profiles-sync-status">{PROFILE_SYNC_AVAILABLE ? '' : SYNC_LATER}</span>
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
  const [newKind, setNewKind] = useState<ProfileNewFileKind | null>(null);
  const [restoring, setRestoring] = useState(false);
  const backRef = useRef<HTMLButtonElement>(null);

  const runRestore = async () => {
    try {
      await restore(plugin.name);
      notify(`Restored Pane's ${plugin.name}. Sessions using it can reload it.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <div className="flex h-[50px] shrink-0 items-center gap-2.5 border-b border-border-primary px-4">
        <button ref={backRef} type="button" className={cn(TODOS_PILL, TODOS_PILL_OFF)} data-testid="profiles-back" title="Back to Profiles (Esc)" onClick={back}>‹ Profiles</button>
        <PhotoMenu profile={profile} notify={notify} />
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[15px] font-semibold" data-testid="profiles-title">{profileDisplayName(profile.ref)}</span>
          <span className="truncate text-[11.5px] text-text-tertiary">
            {profile.ref} · {agentLabel(profile.harness)}{plugin.bundled ? ` · ships with Pane${plugin.edited ? ', edited' : ''}` : ''}
          </span>
        </span>
        <span className="flex-1" />
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
        <FileTree plugin={plugin} profile={profile} file={file} />
        <FileEditor plugin={plugin} profile={profile} file={file} notify={notify} />
      </div>
      {newKind && <NewFileDialog kind={newKind} plugin={plugin} profile={profile} onClose={() => setNewKind(null)} notify={notify} />}
      <ConfirmDialog
        isOpen={restoring}
        onClose={() => setRestoring(false)}
        onConfirm={() => { void runRestore(); }}
        title={`Restore Pane’s ${plugin.name}?`}
        message={`Your edits to ${plugin.name} are replaced by the version that ships with this Pane (${plugin.version}). Your photos stay.`}
        confirmText="Restore"
        variant="danger"
      />
    </>
  );
}

function FileTree({ plugin, profile, file }: { plugin: ProfilePlugin; profile: ProfileSummary; file: string }) {
  const openFile = useProfilesStore(state => state.openFile);
  const drafts = useProfilesStore(state => state.drafts);
  const rows = useMemo(() => fileTreeRows(plugin.files), [plugin.files]);
  const uses = useMemo(() => new Set(profile.uses), [profile.uses]);
  const treeRef = useRef<HTMLDivElement>(null);
  // Opening a profile puts the keys in its files, on the open one.
  useEffect(() => {
    const open = treeRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    open?.focus({ preventScroll: true });
    open?.scrollIntoView({ block: 'nearest' });
  }, [profile.ref]);
  return (
    <div className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-r border-border-primary py-2" data-testid="profiles-tree">
      <div ref={treeRef} role="tree" aria-label={`${plugin.name} files`} onKeyDown={arrowKeys}>
        {rows.map(row => {
          const pad = { paddingLeft: 10 + row.depth * 16 };
          if (row.kind === 'folder') {
            return (
              <div key={`folder:${row.path}`} role="presentation" className="flex h-[26px] items-center gap-1.5 pr-2 text-[13px] text-text-secondary" style={pad}>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                <Folder className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
                <span className="truncate">{row.name}</span>
                {row.hint && <span className="ml-auto shrink-0 text-[11px] text-text-tertiary">{row.hint}</span>}
              </div>
            );
          }
          const selected = row.path === file;
          const dirty = drafts[fileKey(plugin.name, row.path)] !== undefined;
          return (
            <button
              key={row.path}
              type="button"
              role="treeitem"
              aria-selected={selected}
              data-profiles-item
              data-focus-entry={selected ? '' : undefined}
              data-testid={`profiles-file-${row.path}`}
              title={row.path}
              onClick={() => {
                openFile(row.path);
                requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-testid="profiles-editor"]')?.focus());
              }}
              className={cn('mx-1.5 flex h-[26px] w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-md pr-2 text-left text-[13px] focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive',
                selected ? 'bg-surface-hover text-text-primary' : 'text-text-primary hover:bg-surface-hover')}
              style={{ paddingLeft: pad.paddingLeft - 6 }}
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
              <span className="truncate">{row.name}</span>
              {uses.has(row.path) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-interactive" title={`Used by ${profile.ref}`} aria-label={`used by ${profile.ref}`} />}
              {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-warning" title="Unsaved changes" aria-label="unsaved" data-testid="profiles-file-dirty" />}
              {row.path === profile.entry && <span className="ml-auto shrink-0 text-[11px] text-text-secondary">identity</span>}
            </button>
          );
        })}
      </div>
      <p className="px-3.5 pt-3 text-[12px] leading-snug text-text-tertiary">
        <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-interactive align-middle" aria-hidden="true" />
        Used by {profile.ref}. A plugin’s files are shared by its {plugin.profiles.length} profile{plugin.profiles.length === 1 ? '' : 's'}.
      </p>
    </div>
  );
}

function FileEditor({ plugin, profile, file, notify }: { plugin: ProfilePlugin; profile: ProfileSummary; file: string; notify: (text: string) => void }) {
  const key = fileKey(plugin.name, file);
  const saved = useProfilesStore(state => state.saved[key]);
  const draft = useProfilesStore(state => state.drafts[key]);
  const readFile = useProfilesStore(state => state.readFile);
  const edit = useProfilesStore(state => state.edit);
  const save = useProfilesStore(state => state.save);
  const used = useSessionsByProfile();
  const [readError, setReadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const onDisk = useProfilesStore(state => state.onDisk[key]);
  const resolveDiskChange = useProfilesStore(state => state.resolveDiskChange);

  // Opening a file always reads it again, so a change made outside the tab shows (profileDiskSync.ts).
  useEffect(() => {
    setReadError(null);
    setSaveError(null);
    readFile(plugin.name, file).catch(error => setReadError(error instanceof Error ? error.message : String(error)));
  }, [file, plugin.name, readFile]);

  const dirty = draft !== undefined;
  const value = draft ?? saved ?? '';

  const runSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await save(plugin.name, file);
      const sessions = plugin.profiles.reduce((total, entry) => total + (used.get(entry.ref) ?? 0), 0);
      notify(`Saved ${plugin.name}/${file}.${sessions ? ` ${sessions} Session${sessions === 1 ? '' : 's'} can reload it.` : ''}`);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const status = dirty
    ? 'Unsaved changes'
    : plugin.bundled
      ? plugin.edited ? 'Edited: Pane updates won’t replace your copy' : 'Ships with Pane. Saving makes it yours on this computer'
      : `${agentLabel(profile.harness)}${profile.model ? ` · ${profile.model}` : ''}`;

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="profiles-editor-pane">
      <div className="flex h-[44px] shrink-0 items-center gap-2 border-b border-border-primary px-4">
        <FileText className="h-3.5 w-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
        <span className="truncate font-mono text-[13px] font-semibold" data-testid="profiles-path">{plugin.name}/{file}</span>
        <span className="flex-1" />
        <Button size="sm" onClick={() => { void runSave(); }} disabled={!dirty || saving} data-testid="profiles-save" title={`Save (${MOD}S)`}>
          <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />{saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {onDisk !== undefined && (
        <div role="status" data-testid="profiles-disk-changed" className="flex shrink-0 items-center gap-3 border-b border-status-warning/30 bg-status-warning/10 px-4 py-2 text-[13px] text-text-primary">
          <span className="min-w-0 flex-1">
            {onDisk === null
              ? 'This file was removed outside Pane. Your unsaved edits are still here; Save puts the file back.'
              : 'This file changed outside Pane while you were editing. Reload it, or keep your edits (Save then replaces the other version).'}
          </span>
          <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-disk-reload" onClick={() => resolveDiskChange(plugin.name, file, 'disk')}>
            {onDisk === null ? 'Discard my edits' : 'Reload from disk'}
          </button>
          <button type="button" className={TODOS_HEADER_BUTTON} data-testid="profiles-disk-keep" onClick={() => resolveDiskChange(plugin.name, file, 'mine')}>Keep mine</button>
        </div>
      )}
      {readError && saved === undefined
        ? <p role="alert" className="p-4 text-[13px] text-status-error">{readError}</p>
        : (
          <textarea
            aria-label={`Edit ${plugin.name}/${file}`}
            data-testid="profiles-editor"
            spellCheck={false}
            value={value}
            disabled={saved === undefined}
            onChange={event => edit(plugin.name, file, event.target.value)}
            onKeyDown={event => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                void runSave();
              }
            }}
            className="min-h-0 flex-1 resize-none bg-bg-primary px-4 py-3 font-mono text-[13px] leading-[1.55] text-text-primary focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-interactive)]"
          />
        )}
      {saveError && <p role="alert" className="border-t border-border-primary px-4 py-2 text-[12.5px] text-status-error" data-testid="profiles-save-error">{saveError}</p>}
      <div className="flex h-[34px] shrink-0 items-center border-t border-border-primary px-4 text-[12px] text-text-secondary" data-testid="profiles-editor-status">{status}</div>
    </div>
  );
}

function PhotoMenu({ profile, notify }: { profile: ProfileSummary; notify: (text: string) => void }) {
  const photos = useProfilesStore(state => state.photos);
  const setPhoto = useProfilesStore(state => state.setPhoto);
  const removePhoto = useProfilesStore(state => state.removePhoto);
  const source = profilePhotoSource(photos, profile.ref);
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = async (src: string, done: string) => {
    try {
      await setPhoto(profile.ref, await squarePhoto(src));
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
        accept="image/*"
        className="hidden"
        data-testid="profile-photo-file"
        onChange={event => {
          const chosen = event.target.files?.[0];
          event.target.value = '';
          if (chosen) void readFileAsDataUrl(chosen).then(src => apply(src, 'Photo set for this computer.'), error => notify(error instanceof Error ? error.message : String(error)));
        }}
      />
      <Dropdown
        trigger={(
          <button type="button" className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-interactive" data-testid="profile-photo" title="Change photo" aria-label={`Photo of ${profileDisplayName(profile.ref)}`}>
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
          { id: 'choose', label: 'Choose photo…', icon: ImageIcon, onClick: () => fileRef.current?.click() },
          {
            id: 'remove',
            label: 'Remove my photo',
            icon: X,
            disabled: source !== 'yours',
            onClick: () => {
              removePhoto(profile.ref).then(() => notify('Photo removed.'), error => notify(error instanceof Error ? error.message : String(error)));
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
                onClick={() => { close(); void apply(sample.src, 'Photo set for this computer.'); }}
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
      open(result.plugin.name, result.plugin.profiles[0]?.name ?? name, result.path);
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

function NewFileDialog({ kind, plugin, profile, onClose, notify }: { kind: ProfileNewFileKind; plugin: ProfilePlugin; profile: ProfileSummary; onClose: () => void; notify: (text: string) => void }) {
  const newFile = useProfilesStore(state => state.newFile);
  const openFile = useProfilesStore(state => state.openFile);
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
      openFile(result.path);
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
