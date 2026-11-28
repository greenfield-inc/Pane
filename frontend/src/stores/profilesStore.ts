import { create } from 'zustand';
import {
  profilePhotosSchema,
  profileSaveResultSchema,
  profilesOverviewSchema,
  type ProfileDetails,
  type ProfileNewFileKind,
  type ProfilePhotos,
  type ProfilePhotoSource,
  type ProfilePlugin,
  type ProfileSaveResult,
  type ProfilesOverview,
} from '../../../shared/types/profileEditor';
import { reconcileFromDisk, type FileCopy } from '../components/profiles/profileDiskSync';
import { findNode } from '../components/profiles/profilePreview';
import { profileSyncStatusSchema, type ProfileSyncStatus } from '../../../shared/types/profileSync';
import { boundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../../../shared/validation/boundaryDecoder';

/** Where the Profiles tab is: the list, or a profile's files with one file open. */
type ProfilesPlace = { level: 'list' } | { level: 'profile'; plugin: string; profile: string; file: string };

interface ProfilesState {
  overview: ProfilesOverview | null;
  loading: boolean;
  /** Why the list couldn't be read. */
  error: string | null;
  photos: ProfilePhotos;
  photosLoaded: boolean;
  place: ProfilesPlace;
  /** Saved file contents read so far, by `plugin/path`. */
  saved: Record<string, string>;
  /** Unsaved edits, by `plugin/path`; kept while you look at other files or leave the tab. */
  drafts: Record<string, string>;
  /** Files that changed on disk while they had unsaved edits: the new content, or null when removed (profileDiskSync.ts). */
  onDisk: Record<string, string | null>;
  /** Reads the list and the open file again, picking up changes made outside the tab. */
  refresh: () => Promise<void>;
  /** The changed-on-disk choice: take the disk's version (dropping your edit), or keep your edit. */
  resolveDiskChange: (plugin: string, file: string, take: 'disk' | 'mine') => void;
  load: () => Promise<void>;
  loadPhotos: () => Promise<void>;
  open: (plugin: string, profile: string, file?: string) => void;
  openFile: (file: string) => void;
  back: () => void;
  readFile: (plugin: string, file: string) => Promise<void>;
  edit: (plugin: string, file: string, content: string) => void;
  save: (plugin: string, file: string) => Promise<ProfileSaveResult>;
  newProfile: (name: string, agent: string) => Promise<ProfileSaveResult>;
  newFile: (plugin: string, profile: string, kind: ProfileNewFileKind, name: string) => Promise<ProfileSaveResult>;
  restore: (plugin: string) => Promise<ProfileSaveResult>;
  /** Edit details: a profile's title and description, saved in its plugin's pane.yaml. */
  setDetails: (plugin: string, profile: string, details: ProfileDetails) => Promise<ProfileSaveResult>;
  /** YAML as data for a preview (main parses it), or why it doesn't parse. */
  parseYaml: (source: string) => Promise<{ data?: JsonValue; error?: string }>;
  setPhoto: (ref: string, base64: string) => Promise<void>;
  removePhoto: (ref: string) => Promise<void>;
  /** How each of your other computers stands with this one's profiles; null until read. */
  sync: ProfileSyncStatus | null;
  loadSync: () => Promise<void>;
  /** Sync now: sends every profile to every computer again. */
  syncNow: () => Promise<ProfileSyncStatus>;
  /** Follows sync and changes that arrive from other computers while the tab is open; returns the stop. */
  follow: () => () => void;
}

const EMPTY_PHOTOS: ProfilePhotos = { profiles: {}, plugins: {} };

export const fileKey = (plugin: string, file: string): string => `${plugin}/${file}`;

/**
 * The profile page shows a cover page or a file. A cover is `cover:` plus the tree id of the
 * subagent it belongs to (empty for the profile itself); no file path starts with `cover:`.
 */
export const coverPlace = (subagentId = ''): string => `cover:${subagentId}`;
export const isCoverPlace = (file: string): boolean => file.startsWith('cover:');

/** The file a page place shows on disk: the file itself, or a cover's own file when it has one. */
export function shownFile(overview: ProfilesOverview | null, plugin: string, profile: string, file: string): string | undefined {
  if (!isCoverPlace(file)) return file;
  const entry = overview?.plugins.find(item => item.name === plugin);
  const summary = entry?.profiles.find(item => item.name === profile);
  const id = file.slice('cover:'.length);
  if (!id) return summary?.cover;
  const node = summary ? findNode(summary.tree, id) : undefined;
  const ref = node?.kind === 'subagent' ? node.profile : undefined;
  return ref ? entry?.profiles.find(item => item.ref === ref)?.cover : undefined;
}

/**
 * The file on disk the open place shows, for reading only: `shownFile`, or for a cover Pane
 * generates (no cover file), the identity file its "What it does" comes from, so each poll keeps
 * and refreshes that text (review F-4). Editing stays with `shownFile`: a generated cover isn't edited.
 */
export function displayedFile(overview: ProfilesOverview | null, plugin: string, profile: string, file: string): string | undefined {
  const shown = shownFile(overview, plugin, profile, file);
  if (shown || !isCoverPlace(file)) return shown;
  const summary = overview?.plugins.find(item => item.name === plugin)?.profiles.find(item => item.name === profile);
  const id = file.slice('cover:'.length);
  if (!id) return summary?.entry || undefined;
  const node = summary ? findNode(summary.tree, id) : undefined;
  return node?.kind === 'subagent' ? node.identity || undefined : undefined;
}

const yamlAnswer =boundary.object({ data: boundary.optional(boundary.json), error: boundary.optional(boundary.string) });
/** Parsed YAML by source: previews ask again on every render. */
const parsedYaml = new Map<string, { data?: JsonValue; error?: string }>();

function api() {
  const profiles = window.electronAPI?.profiles;
  if (!profiles) throw new Error('Profiles are only in the desktop app.');
  return profiles;
}

/** The data of a `profiles:*` answer, decoded; throws its error, which already says what to do. */
async function answer<T>(call: Promise<{ success: boolean; data?: unknown; error?: string }>, schema: BoundarySchema<T>): Promise<T> {
  const response = await call;
  if (!response.success) throw new Error(response.error ?? 'Pane couldn\'t change its profiles.');
  const data = decodeOptionalBoundary(response.data, schema);
  if (data === undefined) throw new Error('Pane got an answer it couldn\'t read from its profiles. Restart Pane, then try again.');
  return data;
}

/** A `profiles:*` answer that carries no data. */
const nothing: BoundarySchema<null> = { decode: () => null };

/** One refresh at a time: a slow read is never overtaken by the next poll. */
let refreshing = false;
/** Counts the tab's own changes, so a list read that started before one never undoes it (a new profile vanishing, QA round 2). */
let changes = 0;

/** The open file's place in `state`, as one record (profileDiskSync.ts's FileCopy). */
function copyOf(state: Pick<ProfilesState, 'saved' | 'drafts' | 'onDisk'>, key: string): FileCopy {
  const copy: FileCopy = {};
  if (key in state.saved) copy.saved = state.saved[key];
  if (key in state.drafts) copy.draft = state.drafts[key];
  if (key in state.onDisk) copy.onDisk = state.onDisk[key];
  return copy;
}

/** Writes one file's copy back into the three maps. */
function withCopy(state: Pick<ProfilesState, 'saved' | 'drafts' | 'onDisk'>, key: string, copy: FileCopy): Pick<ProfilesState, 'saved' | 'drafts' | 'onDisk'> {
  const saved = { ...state.saved };
  const drafts = { ...state.drafts };
  const onDisk = { ...state.onDisk };
  delete saved[key];
  delete drafts[key];
  delete onDisk[key];
  if (copy.saved !== undefined) saved[key] = copy.saved;
  if (copy.draft !== undefined) drafts[key] = copy.draft;
  if (copy.onDisk !== undefined) onDisk[key] = copy.onDisk;
  return { saved, drafts, onDisk };
}

function replacePlugin(overview: ProfilesOverview | null, plugin: ProfilePlugin): ProfilesOverview | null {
  if (!overview) return overview;
  const known = overview.plugins.some(entry => entry.name === plugin.name);
  return { ...overview, plugins: known ? overview.plugins.map(entry => (entry.name === plugin.name ? plugin : entry)) : [...overview.plugins, plugin] };
}

/** Drops the saved copies and drafts of a plugin's files, which a restore replaced. */
function withoutPlugin<Value>(record: Record<string, Value>, plugin: string): Record<string, Value> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith(`${plugin}/`)));
}

export const useProfilesStore = create<ProfilesState>((set, get) => {
  /** Applies a save's result: the plugin's new state, and its files read again when next opened. */
  const applied = (result: ProfileSaveResult): ProfileSaveResult => {
    changes += 1;
    set(state => ({ overview: replacePlugin(state.overview, result.plugin) }));
    return result;
  };
  return {
    overview: null,
    loading: false,
    error: null,
    photos: EMPTY_PHOTOS,
    photosLoaded: false,
    place: { level: 'list' },
    saved: {},
    drafts: {},
    onDisk: {},
    load: async () => {
      set({ loading: true });
      try {
        const overview = await answer(api().list(), profilesOverviewSchema);
        set({ overview, loading: false, error: null });
      } catch (error) {
        set({ loading: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
    loadPhotos: async () => {
      if (!window.electronAPI?.profiles) return;
      try {
        set({ photos: await answer(api().photos(), profilePhotosSchema), photosLoaded: true });
      } catch {
        // Without photos every avatar shows its initials, which is what it shows before they load.
        set({ photosLoaded: true });
      }
    },
    // A profile opens on its cover page (build-6 feedback item 3).
    open: (plugin, profile, file) => set({ place: { level: 'profile', plugin, profile, file: file ?? coverPlace() } }),
    openFile: (file) => {
      const place = get().place;
      if (place.level === 'profile') set({ place: { ...place, file } });
    },
    back: () => set({ place: { level: 'list' } }),
    readFile: async (plugin, file) => {
      const content = await answer(api().read(plugin, file), boundary.string);
      const key = fileKey(plugin, file);
      set(state => withCopy(state, key, reconcileFromDisk(copyOf(state, key), content)));
    },
    refresh: async () => {
      if (refreshing || !window.electronAPI?.profiles) return;
      refreshing = true;
      try {
        const before = changes;
        const overview = await answer(api().list(), profilesOverviewSchema).catch(() => undefined);
        // A save or new profile that landed while this read was under way is newer than what it read.
        if (overview && before === changes && JSON.stringify(overview) !== JSON.stringify(get().overview)) set({ overview, error: null });
        const place = get().place;
        const shown = place.level === 'profile' ? displayedFile(get().overview, place.plugin, place.profile, place.file) : undefined;
        const openKey = place.level === 'profile' && shown ? fileKey(place.plugin, shown) : null;
        // Files you aren't looking at and haven't edited are read again when opened.
        set(state => ({ saved: Object.fromEntries(Object.entries(state.saved).filter(([key]) => key === openKey || key in state.drafts)) }));
        if (place.level !== 'profile' || !openKey || !shown) return;
        const plugin = get().overview?.plugins.find(entry => entry.name === place.plugin);
        if (!plugin) return;
        let disk: string | null | undefined = null;
        if (plugin.files.includes(shown)) disk = await answer(api().read(place.plugin, shown), boundary.string).catch(() => undefined);
        if (disk === undefined) return;
        set(state => {
          // You may have opened another file while it was read.
          const now = state.place;
          if (now.level !== 'profile' || now.file !== place.file || now.plugin !== place.plugin) return {};
          const next = withCopy(state, openKey, reconcileFromDisk(copyOf(state, openKey), disk));
          // A file removed on disk with nothing of yours in it gives way to the profile's cover page.
          if (disk === null && !(openKey in next.drafts) && !isCoverPlace(now.file)) return { ...next, place: { ...now, file: coverPlace() } };
          return next;
        });
      } finally {
        refreshing = false;
      }
    },
    resolveDiskChange: (plugin, file, take) => {
      const key = fileKey(plugin, file);
      set(state => {
        const copy = copyOf(state, key);
        if (copy.onDisk === undefined) return {};
        if (take === 'mine') {
          // Your edit stays; it is now measured against what is on disk, and Save writes it (the last save wins).
          return withCopy(state, key, { saved: copy.onDisk ?? copy.saved, draft: copy.draft });
        }
        if (copy.onDisk !== null) return withCopy(state, key, { saved: copy.onDisk });
        // Taking the disk's version of a removed file: it is gone, so open the profile's cover page.
        const place = state.place;
        return { ...withCopy(state, key, {}), place: place.level === 'profile' && place.file === file ? { ...place, file: coverPlace() } : place };
      });
    },
    edit: (plugin, file, content) => {
      const key = fileKey(plugin, file);
      set(state => {
        const drafts = { ...state.drafts };
        if (content === state.saved[key]) delete drafts[key];
        else drafts[key] = content;
        return { drafts };
      });
    },
    save: async (plugin, file) => {
      const key = fileKey(plugin, file);
      const content = get().drafts[key];
      if (content === undefined) throw new Error('There is nothing to save in this file.');
      const result = applied(await answer(api().save(plugin, [{ path: file, content }]), profileSaveResultSchema));
      set(state => {
        const drafts = { ...state.drafts };
        const onDisk = { ...state.onDisk };
        if (drafts[key] === content) delete drafts[key];
        // Your save is now what is on disk.
        delete onDisk[key];
        return { drafts, onDisk, saved: { ...state.saved, [key]: content } };
      });
      return result;
    },
    newProfile: async (name, agent) => applied(await answer(api().newProfile(name, agent), profileSaveResultSchema)),
    newFile: async (plugin, profile, kind, name) => {
      const result = applied(await answer(api().newFile(plugin, profile, kind, name), profileSaveResultSchema));
      // The identity file changed on disk too: read it again, keeping any unsaved edit of it.
      const entry = result.plugin.profiles.find(item => item.name === profile)?.entry;
      if (entry) set(state => ({ saved: Object.fromEntries(Object.entries(state.saved).filter(([key]) => key !== fileKey(plugin, entry))) }));
      return result;
    },
    restore: async (plugin) => {
      const result = applied(await answer(api().restore(plugin), profileSaveResultSchema));
      set(state => {
        // A file you added (New subagent, New skill) is gone after a restore: open the profile's cover instead.
        const current = state.place;
        const place = current.level === 'profile' && current.plugin === plugin && !isCoverPlace(current.file) && !result.plugin.files.includes(current.file)
          ? { ...current, file: coverPlace() }
          : current;
        return { place, saved: withoutPlugin(state.saved, plugin), drafts: withoutPlugin(state.drafts, plugin), onDisk: withoutPlugin(state.onDisk, plugin) };
      });
      return result;
    },
    setDetails: async (plugin, profile, details) => applied(await answer(api().setDetails(plugin, profile, details), profileSaveResultSchema)),
    parseYaml: async (source) => {
      const known = parsedYaml.get(source);
      if (known) return known;
      const parsed = await answer(api().parseYaml(source), yamlAnswer).catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
      if (parsedYaml.size > 200) parsedYaml.clear();
      parsedYaml.set(source, parsed);
      return parsed;
    },
    setPhoto: async (ref, base64) => {
      await answer(api().setPhoto(ref, base64), nothing);
      await get().loadPhotos();
    },
    removePhoto: async (ref) => {
      await answer(api().removePhoto(ref), nothing);
      await get().loadPhotos();
    },
    sync: null,
    loadSync: async () => {
      try { set({ sync: await answer(api().syncStatus(), profileSyncStatusSchema) }); }
      catch { /* The footer says nothing about other computers until it can read them. */ }
    },
    syncNow: async () => {
      const sync = await answer(api().syncNow(), profileSyncStatusSchema);
      set({ sync });
      return sync;
    },
    follow: () => {
      const profiles = window.electronAPI?.profiles;
      if (!profiles?.onSyncStatus) return () => undefined;
      const stopStatus = profiles.onSyncStatus(status => {
        const sync = decodeOptionalBoundary(status, profileSyncStatusSchema);
        if (sync) set({ sync });
      });
      // A save that arrived from another computer shows at once, the way a change outside the tab does:
      // an unedited open file reloads, and one with unsaved edits asks whether to reload or keep yours.
      const stopChanged = profiles.onChanged(() => {
        void get().refresh();
        void get().loadPhotos();
      });
      return () => { stopStatus(); stopChanged(); };
    },
  };
});

/** `plugin/profile` of a profile ref, without its variant. */
function qualified(ref: string): string {
  return ref.split(':')[0];
}

/** A profile's picture here: your photo, else its plugin's own picture; undefined shows its initials. */
export function profilePicture(photos: ProfilePhotos, ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const name = qualified(ref);
  return photos.profiles[name] ?? photos.plugins[name.split('/')[0]];
}

export function profilePhotoSource(photos: ProfilePhotos, ref: string): ProfilePhotoSource {
  const name = qualified(ref);
  if (photos.profiles[name]) return 'yours';
  return photos.plugins[name.split('/')[0]] ? 'plugin' : 'default';
}

let photosRequested = false;

/** Loads this computer's profile photos once, the first time an avatar asks. */
export function ensureProfilePhotos(): void {
  if (photosRequested) return;
  photosRequested = true;
  void useProfilesStore.getState().loadPhotos();
}
