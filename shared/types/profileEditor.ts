import { boundary, type BoundarySchema, type JsonValue } from '../validation/boundaryDecoder';

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
  /** Ships with Pane (greenfield). */
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
  /** Its description: the one set in Edit details (pane.yaml), else the identity's own. */
  description?: string;
  /** Its title from Edit details (pane.yaml); absent shows the name Pane makes from the ref. */
  title?: string;
  /**
   * Whether it is a top-level profile, shown in the list and in New. Agent Farm reports
   * `listed: false` for a profile another profile runs as a subagent; absent there means listed.
   */
  listed: boolean;
  /** Its cover page, `covers/<profile>.html` or `.md`, when the plugin has one; else Pane makes one. */
  cover?: string;
  /** The plugin's files this profile reads (its settings, identity, subagents, skills, references, instructions). */
  uses: string[];
  /** Its own files and subagents, nested, as the profile page's tree shows them. */
  tree: ProfileTreeNode[];
}

/**
 * One row of a profile's file tree: a file, a folder (Instructions, Skills, a skill, References,
 * Settings), or a subagent with its own files nested under it.
 */
export type ProfileTreeNode =
  | { kind: 'file'; id: string; path: string; label: string; note?: string }
  | { kind: 'folder'; id: string; label: string; children: ProfileTreeNode[] }
  | ProfileSubagentNode;

export interface ProfileSubagentNode {
  kind: 'subagent';
  id: string;
  /** The name the parent calls it by. */
  alias: string;
  /** The agent it runs (`agents/<agent>.md`). */
  agent: string;
  label: string;
  harness: string;
  model?: string;
  description?: string;
  /** `plugin/profile` when a profile in the plugin runs this agent, so its own cover and avatar apply. */
  profile?: string;
  /** Its identity file. */
  identity: string;
  children: ProfileTreeNode[];
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

/** A tree node, decoded through `treeNodeSchema` once it exists (the tree nests). */
const anyTreeNode: BoundarySchema<ProfileTreeNode> = { decode: cursor => treeNodeSchema.decode(cursor) };

const treeNodeSchema: BoundarySchema<ProfileTreeNode> = boundary.union(
  boundary.object({ kind: boundary.literal('file'), id: boundary.string, path: boundary.string, label: boundary.string, note: boundary.optional(boundary.string) }),
  boundary.object({ kind: boundary.literal('folder'), id: boundary.string, label: boundary.string, children: boundary.array(anyTreeNode) }),
  boundary.object({
    kind: boundary.literal('subagent'),
    id: boundary.string,
    alias: boundary.string,
    agent: boundary.string,
    label: boundary.string,
    harness: boundary.string,
    model: boundary.optional(boundary.string),
    description: boundary.optional(boundary.string),
    profile: boundary.optional(boundary.string),
    identity: boundary.string,
    children: boundary.array(anyTreeNode),
  }),
);

const profileSummarySchema: BoundarySchema<ProfileSummary> = boundary.object({
  name: boundary.nonEmptyString,
  ref: boundary.nonEmptyString,
  entry: boundary.string,
  harness: boundary.string,
  model: boundary.optional(boundary.string),
  description: boundary.optional(boundary.string),
  title: boundary.optional(boundary.string),
  listed: boundary.boolean,
  cover: boundary.optional(boundary.string),
  uses: boundary.array(boundary.string),
  tree: boundary.array(anyTreeNode),
});

/** YAML as data for a preview (main parses it), or why it doesn't parse, with its line. */
export interface ParsedYaml {
  data?: JsonValue;
  error?: string;
}

/** What Edit details sets for a profile, saved in its plugin's pane.yaml. Empty clears it. */
export interface ProfileDetails {
  title: string;
  description: string;
}

export const profileDetailsSchema: BoundarySchema<ProfileDetails> = boundary.object({ title: boundary.string, description: boundary.string });

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
