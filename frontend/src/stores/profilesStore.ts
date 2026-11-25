import { create } from 'zustand';
import {
  profilePhotosSchema,
  profileSaveResultSchema,
  profilesOverviewSchema,
  type ProfileNewFileKind,
  type ProfilePhotos,
  type ProfilePhotoSource,
  type ProfilePlugin,
  type ProfileSaveResult,
  type ProfilesOverview,
} from '../../../shared/types/profileEditor';
import { reconcileFromDisk, type FileCopy } from '../components/profiles/profileDiskSync';
import { boundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';

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
  setPhoto: (ref: string, base64: string) => Promise<void>;
  removePhoto: (ref: string) => Promise<void>;
}

const EMPTY_PHOTOS: ProfilePhotos = { profiles: {}, plugins: {} };

export const fileKey = (plugin: string, file: string): string => `${plugin}/${file}`;

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
    open: (plugin, profile, file) => {
      const entry = get().overview?.plugins.find(item => item.name === plugin)?.profiles.find(item => item.name === profile);
      set({ place: { level: 'profile', plugin, profile, file: file ?? entry?.entry ?? 'plugin.yaml' } });
    },
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
        const overview = await answer(api().list(), profilesOverviewSchema).catch(() => undefined);
        if (overview && JSON.stringify(overview) !== JSON.stringify(get().overview)) set({ overview, error: null });
        const place = get().place;
        const openKey = place.level === 'profile' ? fileKey(place.plugin, place.file) : null;
        // Files you aren't looking at and haven't edited are read again when opened.
        set(state => ({ saved: Object.fromEntries(Object.entries(state.saved).filter(([key]) => key === openKey || key in state.drafts)) }));
        if (place.level !== 'profile' || !openKey) return;
        const plugin = get().overview?.plugins.find(entry => entry.name === place.plugin);
        if (!plugin) return;
        let disk: string | null | undefined = null;
        if (plugin.files.includes(place.file)) disk = await answer(api().read(place.plugin, place.file), boundary.string).catch(() => undefined);
        if (disk === undefined) return;
        set(state => {
          // You may have opened another file while it was read.
          const now = state.place;
          if (now.level !== 'profile' || fileKey(now.plugin, now.file) !== openKey) return {};
          const next = withCopy(state, openKey, reconcileFromDisk(copyOf(state, openKey), disk));
          // A file removed on disk with nothing of yours in it gives way to the profile's identity.
          if (disk === null && !(openKey in next.drafts)) {
            const entry = plugin.profiles.find(item => item.name === now.profile)?.entry;
            return { ...next, place: { ...now, file: entry ?? 'plugin.yaml' } };
          }
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
        // Taking the disk's version of a removed file: it is gone, so open the profile's identity.
        const place = state.place;
        const entry = place.level === 'profile' ? state.overview?.plugins.find(item => item.name === place.plugin)?.profiles.find(item => item.name === place.profile)?.entry : undefined;
        return { ...withCopy(state, key, {}), place: place.level === 'profile' && entry ? { ...place, file: entry } : place };
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
        // A file you added (New subagent, New skill) is gone after a restore: open the profile's identity instead.
        const current = state.place;
        const place = current.level === 'profile' && current.plugin === plugin && !result.plugin.files.includes(current.file)
          ? { ...current, file: result.plugin.profiles.find(item => item.name === current.profile)?.entry ?? result.path }
          : current;
        return { place, saved: withoutPlugin(state.saved, plugin), drafts: withoutPlugin(state.drafts, plugin), onDisk: withoutPlugin(state.onDisk, plugin) };
      });
      return result;
    },
    setPhoto: async (ref, base64) => {
      await answer(api().setPhoto(ref, base64), nothing);
      await get().loadPhotos();
    },
    removePhoto: async (ref) => {
      await answer(api().removePhoto(ref), nothing);
      await get().loadPhotos();
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
