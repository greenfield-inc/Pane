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
/** How many times a run may take one loop edge (an outcome pointing back) before it pauses and asks. */
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

/** Where a run is: a step is running, an ask waits for the person, a loop limit paused it, or it is over. */
export type ProfileRunState = 'running' | 'asking' | 'paused' | 'ended' | 'failed';

/** What the run waits on now. */
export type ProfileRunWait =
  /** A step's tab: an agent step waits for `runpane report --outcome`, a command for its exit. */
  | { kind: 'step'; panelId: string }
  /** An Approvals card: an ask, a loop-limit question or "set outcome" for a step whose tab closed. */
  | { kind: 'card'; approvalId: string; card: 'ask' | 'loop' | 'set-outcome' }
  | { kind: 'none' };

/** One finished step of a run, in order. */
export interface ProfileRunHistoryEntry {
  step: string;
  /** The outcome or choice it took; absent for a step that ended the run. */
  took?: string;
  /** The typed answer of an ask with `next`. */
  answer?: string;
  /** Who chose: the agent's report, the command's exit code, or you. */
  by: 'agent' | 'command' | 'you';
  panelId?: string;
  summary?: string;
  at: string;
}

/** A launched profile: the file Pane follows, where its steps run, and where it is now. */
export interface ProfileRun {
  id: string;
  profile: string;
  profileVersion: string;
  /** The Session the run belongs to; its folder holds this run's file. */
  sessionId: string;
  repoId: number;
  /** The Pane the first step opened; every later step is a tab in it. */
  paneId?: string;
  /** What the person asked for: the first agent step's request. */
  prompt: string;
  /** Agent id → the CLI (`cli` or `cli/model`) chosen at launch, over the file's `runs`. */
  harness: Record<string, string>;
  /** A CLI Pane doesn't know → the command that starts it (baseline: plain terminal). */
  commands: Record<string, string>;
  state: ProfileRunState;
  /** The current step, or the last one once ended. */
  step: string;
  wait: ProfileRunWait;
  /** The previous step's result, passed to the next step in its first message. */
  carry?: string;
  /** `from › outcome` → times this run took that loop edge (one pointing back in the file). */
  edgeCounts: Record<string, number>;
  /** When paused at a loop limit: the edge it would take on "go again". */
  pending?: { from: string; took: string; to: string; by: 'agent' | 'command' | 'you'; summary?: string };
  history: ProfileRunHistoryEntry[];
  error?: string;
  /** Something in a step's tab waits on the person, such as an agent's folder-trust prompt in a new worktree. Cleared on the next move. */
  attention?: string;
  createdAt: string;
  updatedAt: string;
}

/** One profile from the person's own Agent Farm ("Your Agent Farm"), read-only. */
export interface OwnAgentFarmProfileView {
  name: string;
  source: string;
  harness?: string;
  model?: string;
}

/** What the Profiles page lists. */
export interface ProfileLibraryView {
  profiles: LibraryProfile[];
  /** The Agent Farm bundled in Pane: set up, setting up, or why not. */
  agentFarm?: { state: 'missing' | 'installing' | 'ready' | 'failed'; version?: string; error?: string };
  /** The person's own agent-farm on PATH, listed through it; absent when none is installed. */
  ownAgentFarm?: { profiles: OwnAgentFarmProfileView[]; error?: string };
}

/** One profile with its file's text, for the YAML tab. */
export interface ProfileDetailView {
  profile: LibraryProfile;
  yaml: string;
}

/** A launch from the Profiles page or runpane. */
export interface ProfileLaunchInput {
  profile: string;
  repoId: number;
  /** An existing Session to run in; without it Pane makes a new one named `sessionName` (or after the profile and task). */
  sessionId?: string;
  sessionName?: string;
  prompt: string;
  /** Agent id → `cli` or `cli/model`, over the file's `runs`. */
  harness?: Record<string, string>;
  /** A CLI Pane doesn't know → the command that starts it. */
  commands?: Record<string, string>;
}
