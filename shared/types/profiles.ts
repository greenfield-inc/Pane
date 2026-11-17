/**
 * Profiles (pane-profile/1): one YAML file that defines a team of agents and a fixed
 * workflow built from four primitives: agent, step, outcome and ask. These are the
 * normalized shapes main, the renderer and runpane's JSON share; the validator in
 * shared/profiles/validateProfile.ts turns a parsed file into them.
 */

export const PROFILE_FORMAT = 'pane-profile/1';
/** Reserved step name an outcome, choice or next points to when it ends the run. */
export const PROFILE_END = 'end';
/** Every outcome of an agent step needs this many samples, so its picture can show how results vary. */
export const MIN_SAMPLES_PER_OUTCOME = 2;
/** How many times a run may take one outcome edge before it pauses and asks. */
export const DEFAULT_LOOP_LIMIT = 3;

export interface ProfileAgent {
  id: string;
  /** As written: `cli/model` or `cli`. */
  runs: string;
  cli: string;
  model?: string;
  effort?: string;
  /** File ids from the profile's folder (`instructions/<id>.md` or `<id>.md`). */
  reads: string[];
  skills: string[];
}

/** One way a step ends, and the step (or `end`) that comes next. */
export interface ProfileEdge {
  name: string;
  to: string;
}

interface ProfileStepBase {
  id: string;
  /** The label drawn on the step's box. */
  title: string;
}

/** Judgment work: an agent pursues a goal and reports one of the declared outcomes. */
export interface ProfileAgentStep extends ProfileStepBase {
  kind: 'agent';
  agent: string;
  goal: string;
  outcomes: ProfileEdge[];
}

/** Mechanical work: a shell command. Exit 0 takes the first outcome, anything else the second; none ends the run. */
export interface ProfileCommandStep extends ProfileStepBase {
  kind: 'command';
  run: string;
  outcomes: ProfileEdge[];
}

/** The person is asked: pick one of the choices, or (with `next`) type an answer. */
export interface ProfileAskStep extends ProfileStepBase {
  kind: 'ask';
  ask: string;
  choices: ProfileEdge[];
  next?: string;
}

export type ProfileStep = ProfileAgentStep | ProfileCommandStep | ProfileAskStep;

export interface ProfileFlow {
  start: string;
  /** In file order. */
  steps: ProfileStep[];
}

/** Who chose an edge, which sets its colour in the drawing. */
export type ProfileEdgeChooser = 'agent' | 'you' | 'command';

/** One arrow of the drawing: an outcome, a choice or an ask's `next`. */
export interface ProfileFlowEdge {
  from: string;
  to: string;
  label: string;
  chooser: ProfileEdgeChooser;
}

/** One step of an example run: the step, and the outcome or choice it took (or the answer typed). */
export interface ProfileRunEntry {
  step: string;
  /** The outcome or choice taken; absent on a step that ends the run. */
  took?: string;
  /** For an agent outcome written `name #n`: which sample (1-based) the run shows. */
  sample?: number;
  /** For an ask with `next`: the answer typed. */
  answer?: string;
}

/** step id → outcome name → samples. */
export type ProfileSamples = Record<string, Record<string, string[]>>;
/** Example runs the viewer lights up, by id (A, B, …). */
export type ProfileExampleRuns = Record<string, ProfileRunEntry[]>;

export interface Profile {
  format: typeof PROFILE_FORMAT;
  name: string;
  version: string;
  title?: string;
  description?: string;
  source?: string;
  extends?: string;
  loopLimit: number;
  agents: ProfileAgent[];
  /** Absent: a team-only profile, listed and viewable but not launchable. */
  flow?: ProfileFlow;
  samples: ProfileSamples;
  runs: ProfileExampleRuns;
}

/** One reason a profile is invalid. `message` names the step and outcome; `fix` says what to change. */
export interface ProfileProblem {
  code: string;
  message: string;
  fix: string;
  step?: string;
  outcome?: string;
}

export type ProfileOrigin = 'bundled' | 'yours';

/** A profile as the library lists it: valid or not, with its errors. */
export interface LoadedProfile {
  /** From the file; for a file that does not parse, its file name. */
  name: string;
  version?: string;
  title?: string;
  origin: ProfileOrigin;
  file: string;
  valid: boolean;
  /** Valid and has a flow. */
  launchable: boolean;
  teamOnly: boolean;
  errors: ProfileProblem[];
  /** The merged, normalized profile; absent when the file could not be read as one. */
  profile?: Profile;
}

/** A profile in the library: loaded, plus whether it is on. Bundled profiles are on when named in config `profiles.enabled`; yours are always on. */
export interface LibraryProfile extends LoadedProfile {
  enabled: boolean;
}
