import { boundary, type BoundarySchema } from '../validation/boundaryDecoder';

/** A qualified Agent Farm profile name, optionally with its variant: `plugin/profile[:variant]`. */
export const PROFILE_REF_PATTERN = /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*(?::[a-z][a-z0-9_-]*)?$/;

/** One Agent Farm profile installed in a machine's Pane (`agent-farm profiles list`). */
export interface AgentFarmProfileEntry {
  /** `plugin/profile`. */
  ref: string;
  plugin: string;
  /** The plugin's version. */
  version: string;
  /** The harness of the default variant: `claude` or `codex`. */
  harness: string;
  model?: string;
  effort?: string;
  /** The profile's variants, default first; absent for a profile without variants. */
  variants?: AgentFarmProfileVariant[];
  defaultVariant?: string;
  /** Pane's own plain profiles (`pane/claude`, `pane/codex`), which lists show as the agent itself. */
  hidden: boolean;
  /**
   * False when the profile's Agent Farm plugin marks it unlisted (`listed: false`, such as a
   * subagent's own profile): it runs, but isn't offered when you start a Session. Absent from an
   * Agent Farm too old to say, which counts as listed.
   */
  listed?: boolean;
}

export interface AgentFarmProfileVariant {
  name: string;
  model: string;
  effort?: string;
}

export interface AgentFarmProfileList {
  profiles: AgentFarmProfileEntry[];
  /** Why the list is empty or may be incomplete, and what to do; absent when it was read. */
  error?: string;
}

/**
 * The profile a Session runs through Agent Farm (T-63), saved with the Session. `ref` is a
 * `plugin/profile[:variant]` name; `hash` is the content hash of its plugin when the Session took it.
 * Sessions from before T-63 have none and start their agent directly.
 */
export interface SessionAgentProfile {
  ref: string;
  hash: string;
}

export const sessionAgentProfileSchema: BoundarySchema<SessionAgentProfile> = boundary.object({
  ref: boundary.nonEmptyString,
  hash: boundary.string,
});

const profileEntrySchema: BoundarySchema<AgentFarmProfileEntry> = boundary.object({
  ref: boundary.nonEmptyString,
  plugin: boundary.nonEmptyString,
  version: boundary.string,
  harness: boundary.nonEmptyString,
  model: boundary.optional(boundary.string),
  effort: boundary.optional(boundary.string),
  variants: boundary.optional(boundary.array(boundary.object({ name: boundary.nonEmptyString, model: boundary.string, effort: boundary.optional(boundary.string) }))),
  defaultVariant: boundary.optional(boundary.string),
  hidden: boundary.boolean,
  listed: boundary.optional(boundary.boolean),
});

export const agentFarmProfileListSchema: BoundarySchema<AgentFarmProfileList> = boundary.object({
  profiles: boundary.array(profileEntrySchema),
  error: boundary.optional(boundary.string),
});
