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

function replacePlugin(overview: ProfilesOverview | null, plugin: ProfilePlugin): ProfilesOverview | null {
  if (!overview) return overview;
  const known = overview.plugins.some(entry => entry.name === plugin.name);
  return { ...overview, plugins: known ? overview.plugins.map(entry => (entry.name === plugin.name ? plugin : entry)) : [...overview.plugins, plugin] };
}

/** Drops the saved copies and drafts of a plugin's files, which a restore replaced. */
function withoutPlugin(record: Record<string, string>, plugin: string): Record<string, string> {
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
      set(state => ({ saved: { ...state.saved, [fileKey(plugin, file)]: content } }));
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
        if (drafts[key] === content) delete drafts[key];
        return { drafts, saved: { ...state.saved, [key]: content } };
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
        return { place, saved: withoutPlugin(state.saved, plugin), drafts: withoutPlugin(state.drafts, plugin) };
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
