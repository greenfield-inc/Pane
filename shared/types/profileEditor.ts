import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';

/**
 * The Profiles tab (T-63 PR 5): the Agent Farm plugins in this computer's Pane, their profiles and
 * files, as main reads them from `<PANE_DIR>/agent-farm`. Pane's own plain plugin (`pane`) is left out.
 */
export interface ProfilesOverview {
  plugins: ProfilePlugin[];
  /** This computer's name, which the tab shows the profiles of. */
  machine: string;
  /** Why the list is empty or incomplete, and what to do; absent when every plugin was read. */
  error?: string;
}

export interface ProfilePlugin {
  name: string;
  version: string;
  description?: string;
  /** Ships with Pane (greenfield, dcouple). */
  bundled: boolean;
  /** Ships with Pane and was changed here, so Pane updates no longer replace it (A-3). */
  edited: boolean;
  profiles: ProfileSummary[];
  /** Every file in the plugin's sections and plugin.yaml, relative with `/`, sorted. */
  files: string[];
}

export interface ProfileSummary {
  /** The profile's name in its plugin. */
  name: string;
  /** `plugin/profile`. */
  ref: string;
  /** The identity file of the default variant, such as `agents/orchestrator.md`. */
  entry: string;
  harness: string;
  model?: string;
  description?: string;
  /** The plugin's files this profile reads (its settings, identity, subagents, skills, references, instructions). */
  uses: string[];
}

/** Where a profile's avatar picture comes from: your photo here, the plugin's own picture, or none (initials). */
export type ProfilePhotoSource = 'yours' | 'plugin' | 'default';

/** Profile pictures on this computer, as data URLs: your photos by `plugin/profile`, plugin pictures by plugin. */
export interface ProfilePhotos {
  profiles: Record<string, string>;
  plugins: Record<string, string>;
}

/** One file of a plugin and its content. */
export interface ProfileFileChange {
  path: string;
  content: string;
}

export type ProfileNewFileKind = 'subagent' | 'skill' | 'reference';

/** What saving or creating files did: the plugin as it is now. */
export interface ProfileSaveResult {
  plugin: ProfilePlugin;
  /** The file to open next: the new file, or the one saved. */
  path: string;
}

const profileSummarySchema: BoundarySchema<ProfileSummary> = boundary.object({
  name: boundary.nonEmptyString,
  ref: boundary.nonEmptyString,
  entry: boundary.string,
  harness: boundary.string,
  model: boundary.optional(boundary.string),
  description: boundary.optional(boundary.string),
  uses: boundary.array(boundary.string),
});

export const profilePluginSchema: BoundarySchema<ProfilePlugin> = boundary.object({
  name: boundary.nonEmptyString,
  version: boundary.string,
  description: boundary.optional(boundary.string),
  bundled: boundary.boolean,
  edited: boundary.boolean,
  profiles: boundary.array(profileSummarySchema),
  files: boundary.array(boundary.string),
});

export const profilesOverviewSchema: BoundarySchema<ProfilesOverview> = boundary.object({
  plugins: boundary.array(profilePluginSchema),
  machine: boundary.string,
  error: boundary.optional(boundary.string),
});

export const profilePhotosSchema: BoundarySchema<ProfilePhotos> = boundary.object({
  profiles: boundary.record(boundary.string),
  plugins: boundary.record(boundary.string),
});

export const profileSaveResultSchema: BoundarySchema<ProfileSaveResult> = boundary.object({
  plugin: profilePluginSchema,
  path: boundary.string,
});

export const profileFileChangesSchema: BoundarySchema<ProfileFileChange[]> = boundary.array(boundary.object({ path: boundary.nonEmptyString, content: boundary.string }));

/** A plugin, profile, subagent, skill or reference name, as Agent Farm accepts it. */
export const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Sync across computers arrives in PR 6 (T-63). Until then the tab's Sync button and footer say so;
 * PR 6 turns this on.
 */
export const PROFILE_SYNC_AVAILABLE = false;
