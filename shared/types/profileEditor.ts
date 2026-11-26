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

/**
 * One profile, as `agent-farm profiles list --json` lists it (T-83): every entry under a plugin's
 * profiles/ is a profile; the helpers it starts are agents in its tree.
 */
export interface ProfileSummary {
  /** The profile's name in its plugin. */
  name: string;
  /** `plugin/profile`. */
  ref: string;
  /** The identity file of the default variant, such as `agents/orchestrator.md`; empty when it lives in another plugin. */
  entry: string;
  /** The default variant's harness. */
  harness: string;
  model?: string;
  /** Agent Farm's title, with your edit (`profiles set`) merged in; absent shows the name Pane makes from the ref. */
  title?: string;
  /** Agent Farm's description, with your edit merged in. */
  description?: string;
  /** Its variants, `claude` and `codex`, default first; absent for a single-agent profile. */
  variants?: string[];
  /** Its cover page, `covers/<profile>.html` or `.md`, when the plugin has one; else Pane makes one. */
  cover?: string;
  /** Its own files and the agents it links to, nested, as the profile page's tree shows them. */
  tree: ProfileTreeNode[];
}

/**
 * One row of a profile's file tree: a file, a folder (Instructions, Skills, a skill, References,
 * Subagents, Settings), or a linked agent with its own files and links nested under it.
 */
export type ProfileTreeNode =
  | { kind: 'file'; id: string; path: string; label: string; note?: string }
  | { kind: 'folder'; id: string; label: string; children: ProfileTreeNode[] }
  | ProfileSubagentNode;

/**
 * How a parent runs a linked agent (Agent Farm's link modes): `native` inside the parent's own
 * harness, `process` as its own headless process, `launch` as its own launch, in a tab or headless.
 */
export type ProfileLinkMode = 'native' | 'process' | 'launch';

export interface ProfileSubagentNode {
  kind: 'subagent';
  id: string;
  /** The name the parent calls it by. */
  alias: string;
  /** The agent it runs, `plugin/agent`; for an `any` link, the plugin's name. */
  agent: string;
  label: string;
  mode: ProfileLinkMode;
  /** The harness of the agent (its default variant's); absent when Pane can't read it (another plugin's agent). */
  harness?: string;
  model?: string;
  description?: string;
  /** Its variants, `claude` and `codex`, default first, for an agent that has both. */
  variants?: string[];
  /** The command that starts it on its own, for process and launch links (no `--parent`: a person needs none). */
  command?: string;
  /** A link back to an agent already above it on this path: it isn't expanded again. */
  cycle?: boolean;
  /** An `any: true` link: it may start any agent in its plugin. */
  any?: boolean;
  /** Why Agent Farm couldn't resolve the link's target. */
  error?: string;
  /** `plugin/profile` when a profile in the plugin runs this agent, so its own cover and avatar apply. */
  profile?: string;
  /** Its identity file in this plugin; absent for another plugin's agent or an `any` link. */
  identity?: string;
  children: ProfileTreeNode[];
}

/** Where a profile's photo comes from: your edit (`profiles set`), the plugin's own SVG, or none (initials). */
export type ProfilePhotoSource = 'yours' | 'plugin' | 'default';

/** Profile photos on this computer (SVG only, T-83), as data URLs by `plugin/profile`, and where each came from. */
export interface ProfilePhotos {
  profiles: Record<string, string>;
  sources: Record<string, Exclude<ProfilePhotoSource, 'default'>>;
}

/** Largest SVG photo Agent Farm accepts (T-83 §5). */
export const MAX_PROFILE_PHOTO_BYTES = 64 * 1024;

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
    mode: boundary.enumeration('native', 'process', 'launch'),
    harness: boundary.optional(boundary.string),
    model: boundary.optional(boundary.string),
    description: boundary.optional(boundary.string),
    variants: boundary.optional(boundary.array(boundary.string)),
    command: boundary.optional(boundary.string),
    cycle: boundary.optional(boundary.boolean),
    any: boundary.optional(boundary.boolean),
    error: boundary.optional(boundary.string),
    profile: boundary.optional(boundary.string),
    identity: boundary.optional(boundary.string),
    children: boundary.array(anyTreeNode),
  }),
);

const profileSummarySchema: BoundarySchema<ProfileSummary> = boundary.object({
  name: boundary.nonEmptyString,
  ref: boundary.nonEmptyString,
  entry: boundary.string,
  harness: boundary.string,
  model: boundary.optional(boundary.string),
  title: boundary.optional(boundary.string),
  description: boundary.optional(boundary.string),
  variants: boundary.optional(boundary.array(boundary.string)),
  cover: boundary.optional(boundary.string),
  tree: boundary.array(anyTreeNode),
});

/** YAML as data for a preview (main parses it), or why it doesn't parse, with its line. */
export interface ParsedYaml {
  data?: JsonValue;
  error?: string;
}

/** What Edit details sets for a profile through `agent-farm profiles set`. Empty goes back to the plugin's own. */
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
  sources: boundary.record(boundary.enumeration('yours', 'plugin')),
});

export const profileSaveResultSchema: BoundarySchema<ProfileSaveResult> = boundary.object({
  plugin: profilePluginSchema,
  path: boundary.string,
});

export const profileFileChangesSchema: BoundarySchema<ProfileFileChange[]> = boundary.array(boundary.object({ path: boundary.nonEmptyString, content: boundary.string }));

/** A plugin, profile, subagent, skill or reference name, as Agent Farm accepts it. */
export const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;
