import {
  DEFAULT_LOOP_LIMIT,
  MIN_SAMPLES_PER_OUTCOME,
  PROFILE_END,
  PROFILE_FORMAT,
  type Profile,
  type ProfileAgent,
  type ProfileEdge,
  type ProfileExampleRuns,
  type ProfileFlow,
  type ProfileProblem,
  type ProfileRunEntry,
  type ProfileSamples,
  type ProfileStep,
} from '../types/profiles';
import { boundary, decodeOptionalBoundary, type JsonObject, type JsonValue } from '../validation/boundaryDecoder';
import { isTerminalStep, reachableSteps, stepEdges } from './flowGraph';

/** What the validator can check outside the file itself. Each check is skipped when its callback is absent. */
export interface ProfileValidationContext {
  /** Whether an agent's `reads` id names a file in the profile's folder. */
  readExists?: (id: string) => boolean;
  /** Whether an agent's skill is installed. */
  skillExists?: (name: string) => boolean;
}

export interface ProfileValidation {
  /** Present when the file has the profile's basic shape, even if other rules fail. */
  profile?: Profile;
  errors: ProfileProblem[];
}

type Raw = JsonValue | undefined;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const RUNS_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/(\S+))?$/u;
const SAMPLE_REF_PATTERN = /^(.*\S)\s+#(\d+)$/u;
const HEADER_TEXT_KEYS = ['title', 'description', 'source', 'extends'] as const;

/** The value as a set of keys, or undefined. */
function asMap(value: Raw): JsonObject | undefined {
  return decodeOptionalBoundary(value, boundary.jsonObject);
}

/** The value as trimmed, non-empty text, or undefined. */
function text(value: Raw): string | undefined {
  return decodeOptionalBoundary(value, boundary.nonEmptyString)?.trim();
}

function isAbsent(value: Raw): boolean {
  return value === undefined || value === null;
}

/** The value as a list of text (absent reads as empty), or undefined when it is something else. */
function textList(value: Raw): string[] | undefined {
  if (isAbsent(value)) return [];
  return decodeOptionalBoundary(value, boundary.array(boundary.string))?.map((item) => item.trim()).filter((item) => item !== '');
}

interface ProblemLocation {
  step?: string;
  outcome?: string;
}

class Problems {
  readonly list: ProfileProblem[] = [];
  add(code: string, message: string, fix: string, where: ProblemLocation = {}): void {
    const problem: ProfileProblem = { code, message, fix };
    if (where.step !== undefined) problem.step = where.step;
    if (where.outcome !== undefined) problem.outcome = where.outcome;
    this.list.push(problem);
  }
}

/**
 * Checks a parsed pane-profile/1 file against every rule of the format and returns it
 * normalized. Each error names the step and outcome it is about and how to fix it.
 */
export function validateProfile(file: JsonValue, context: ProfileValidationContext = {}): ProfileValidation {
  const problems = new Problems();
  const raw = asMap(file);
  if (!raw) {
    problems.add('PROFILE_NOT_A_MAPPING', 'The file is not a profile: its top level is not a set of keys.', `Start the file with "format: ${PROFILE_FORMAT}", then name, version and agents.`);
    return { errors: problems.list };
  }

  if (raw.format !== PROFILE_FORMAT) {
    problems.add('PROFILE_FORMAT', `The file says format ${JSON.stringify(raw.format ?? null)}; Pane reads ${PROFILE_FORMAT}.`, `Set "format: ${PROFILE_FORMAT}".`);
  }
  const name = text(raw.name);
  if (!name || !NAME_PATTERN.test(name)) {
    problems.add('PROFILE_NAME', name ? `The name "${name}" is not allowed: use lowercase letters, digits and dashes.` : 'The profile has no name.', 'Set "name:" to lowercase letters, digits and dashes, for example "my-team".');
  }
  const versionNumber = decodeOptionalBoundary(raw.version, boundary.number);
  const version = versionNumber === undefined ? text(raw.version) : String(versionNumber);
  if (!version || !SEMVER_PATTERN.test(version)) {
    problems.add('PROFILE_VERSION', version ? `The version "${version}" is not semver.` : 'The profile has no version.', 'Set "version:" to three numbers, for example 1.0.0, in quotes if YAML reads it as a number.');
  }
  let loopLimit = DEFAULT_LOOP_LIMIT;
  if (raw.loop_limit !== undefined) {
    const limit = decodeOptionalBoundary(raw.loop_limit, boundary.number);
    if (limit !== undefined && Number.isInteger(limit) && limit > 0) loopLimit = limit;
    else problems.add('PROFILE_LOOP_LIMIT', `loop_limit is ${JSON.stringify(raw.loop_limit)}; it must be a whole number of 1 or more.`, `Set "loop_limit:" to a whole number, or remove it for the default of ${DEFAULT_LOOP_LIMIT}.`);
  }

  const agents = readAgents(raw.agents, problems, context);
  const flow = isAbsent(raw.flow) ? undefined : readFlow(raw.flow, problems);
  if (flow) checkFlow(flow, agents, problems);
  const samples = readSamples(raw.samples, flow, problems);
  const runs = flow ? readRuns(raw.runs, flow, samples, problems) : {};
  if (!flow && !isAbsent(raw.runs)) {
    problems.add('RUNS_WITHOUT_FLOW', 'The file has example runs but no flow for them to follow.', 'Add a flow, or remove "runs:".');
  }

  const profile: Profile = { format: PROFILE_FORMAT, name: name ?? '', version: version ?? '', loopLimit, agents, samples, runs };
  for (const key of HEADER_TEXT_KEYS) {
    const value = text(raw[key]);
    if (value) profile[key] = value;
  }
  if (flow) profile.flow = flow;
  return { profile, errors: problems.list };
}

function readAgents(value: Raw, problems: Problems, context: ProfileValidationContext): ProfileAgent[] {
  if (isAbsent(value)) return [];
  const raw = asMap(value);
  if (!raw) {
    problems.add('AGENTS_SHAPE', '"agents:" is not a set of named agents.', 'Write each agent as "<id>: { runs: <cli>/<model> }".');
    return [];
  }
  const agents: ProfileAgent[] = [];
  for (const [id, entry] of Object.entries(raw)) {
    const fields = asMap(entry);
    if (!fields) {
      problems.add('AGENT_SHAPE', `Agent ${id} is not a set of keys.`, `Write it as "${id}: { runs: <cli>/<model> }".`);
      continue;
    }
    const runs = text(fields.runs);
    const match = runs ? RUNS_PATTERN.exec(runs) : null;
    if (!runs || !match) {
      problems.add('AGENT_RUNS', runs ? `Agent ${id} runs "${runs}", which is not cli/model or cli.` : `Agent ${id} has no "runs:".`, 'Set "runs:" to a CLI and model, for example "<cli>/<model-id>", or a CLI alone.');
    }
    const reads = textList(fields.reads);
    const skills = textList(fields.skills);
    if (!reads) problems.add('AGENT_READS', `Agent ${id}'s "reads:" is not a list of file ids.`, 'Write it as a list, for example [standing-rules].');
    if (!skills) problems.add('AGENT_SKILLS', `Agent ${id}'s "skills:" is not a list of skill names.`, 'Write it as a list, for example [review].');
    for (const read of reads ?? []) {
      if (context.readExists && !context.readExists(read)) {
        problems.add('READ_MISSING', `Agent ${id} reads "${read}", but the profile's folder has no instructions/${read}.md or ${read}.md.`, `Add the file, or remove "${read}" from ${id}'s reads.`);
      }
    }
    for (const skill of skills ?? []) {
      if (context.skillExists && !context.skillExists(skill)) {
        problems.add('SKILL_MISSING', `Agent ${id} uses the skill "${skill}", which is not installed.`, `Install the skill, or remove "${skill}" from ${id}'s skills.`);
      }
    }
    const agent: ProfileAgent = { id, runs: runs ?? '', cli: match?.[1] ?? '', reads: reads ?? [], skills: skills ?? [] };
    if (match?.[2]) agent.model = match[2];
    const effort = text(fields.effort);
    if (effort) agent.effort = effort;
    agents.push(agent);
  }
  return agents;
}

function readEdges(value: Raw, stepId: string, key: 'outcomes' | 'choices', problems: Problems): ProfileEdge[] {
  if (isAbsent(value)) return [];
  const raw = asMap(value);
  if (!raw) {
    problems.add('STEP_EDGES_SHAPE', `Step ${stepId}'s "${key}:" is not a set of "<name>: <next step>" pairs.`, `Write it as "${key}: { <name>: <next step> }".`, { step: stepId });
    return [];
  }
  const edges: ProfileEdge[] = [];
  for (const [name, to] of Object.entries(raw)) {
    const target = text(to);
    if (!target) {
      problems.add('EDGE_TARGET_EMPTY', `Step ${stepId}, ${key === 'choices' ? 'choice' : 'outcome'} ${name} points nowhere.`, `Point it to a step, or to "${PROFILE_END}" to end the run.`, { step: stepId, outcome: name });
      continue;
    }
    edges.push({ name, to: target });
  }
  return edges;
}

function readStep(id: string, value: Raw, problems: Problems): ProfileStep | undefined {
  if (id === PROFILE_END) {
    problems.add('STEP_RESERVED', `A step is named "${id}", which is reserved: it ends the run.`, 'Rename the step.', { step: id });
    return undefined;
  }
  const raw = asMap(value);
  if (!raw) {
    problems.add('STEP_SHAPE', `Step ${id} is not a set of keys.`, `Write it as "${id}: { agent: …, goal: …, outcomes: { … } }", "{ run: … }" or "{ ask: … }".`, { step: id });
    return undefined;
  }
  const kinds = (['agent', 'run', 'ask'] as const).filter((key) => raw[key] !== undefined);
  if (kinds.length !== 1) {
    problems.add('STEP_KIND', kinds.length === 0 ? `Step ${id} is not an agent step, a command or an ask.` : `Step ${id} mixes ${kinds.join(' and ')}.`, 'Give the step exactly one of "agent:", "run:" or "ask:".', { step: id });
    return undefined;
  }
  const title = text(raw.title);
  if (kinds[0] === 'agent') {
    const agent = text(raw.agent) ?? '';
    const goal = text(raw.goal);
    if (!goal) problems.add('STEP_GOAL', `Step ${id} has no goal.`, 'Add "goal:": one line saying what the agent is there to do.', { step: id });
    const outcomes = readEdges(raw.outcomes, id, 'outcomes', problems);
    if (outcomes.length === 0) problems.add('STEP_OUTCOMES', `Step ${id} declares no outcomes.`, 'Add "outcomes:": each way the step can end, and the step that follows it.', { step: id });
    return { kind: 'agent', id, title: title ?? agent, agent, goal: goal ?? '', outcomes };
  }
  if (kinds[0] === 'run') {
    const run = text(raw.run);
    if (!run) problems.add('STEP_RUN', `Step ${id} has an empty command.`, 'Set "run:" to a shell command.', { step: id });
    const outcomes = readEdges(raw.outcomes, id, 'outcomes', problems);
    if (outcomes.length !== 0 && outcomes.length !== 2) {
      problems.add('COMMAND_OUTCOMES', `Command ${id} declares ${outcomes.length} outcome${outcomes.length === 1 ? '' : 's'}; a command has two (exit 0, then any other exit) or none (it ends the run).`, 'List two outcomes, success first, or remove "outcomes:".', { step: id });
    }
    return { kind: 'command', id, title: title ?? run ?? id, run: run ?? '', outcomes };
  }
  const ask = text(raw.ask);
  if (!ask) problems.add('ASK_TEXT', `Ask ${id} has no question.`, 'Set "ask:" to the question the person sees.', { step: id });
  const choices = readEdges(raw.choices, id, 'choices', problems);
  const next = text(raw.next);
  if (raw.next !== undefined && !next) problems.add('EDGE_TARGET_EMPTY', `Ask ${id}'s "next:" points nowhere.`, `Point it to a step, or to "${PROFILE_END}".`, { step: id });
  if ((choices.length > 0) === (next !== undefined)) {
    problems.add('ASK_SHAPE', `Ask ${id} needs either choices or next, not ${choices.length > 0 ? 'both' : 'neither'}.`, 'Give it "choices: { <button>: <next step> }" for buttons, or "next: <step>" for a typed answer.', { step: id });
  }
  const step: ProfileStep = { kind: 'ask', id, title: title ?? ask ?? id, ask: ask ?? '', choices };
  if (next) step.next = next;
  return step;
}

function readFlow(value: Raw, problems: Problems): ProfileFlow | undefined {
  const raw = asMap(value);
  if (!raw) {
    problems.add('FLOW_SHAPE', '"flow:" is not a set of steps.', 'Write "flow:" with "start: <step>" and one key per step.');
    return undefined;
  }
  const steps: ProfileStep[] = [];
  for (const [id, entry] of Object.entries(raw)) {
    if (id === 'start') continue;
    const step = readStep(id, entry, problems);
    if (step) steps.push(step);
  }
  const start = text(raw.start);
  if (!start) problems.add('FLOW_START', 'The flow has no start.', 'Add "start: <step>" to the flow.');
  return { start: start ?? '', steps };
}

function checkFlow(flow: ProfileFlow, agents: ProfileAgent[], problems: Problems): void {
  const ids = new Set(flow.steps.map((step) => step.id));
  const agentIds = new Set(agents.map((agent) => agent.id));
  if (flow.start && !ids.has(flow.start)) {
    problems.add('FLOW_START_MISSING', `The flow starts at "${flow.start}", which is not a step.`, 'Set "start:" to one of the flow\'s steps.', { step: flow.start });
  }
  for (const step of flow.steps) {
    if (step.kind === 'agent' && !agentIds.has(step.agent)) {
      problems.add('STEP_AGENT_MISSING', step.agent ? `Step ${step.id} uses agent ${step.agent}, which is not in "agents:".` : `Step ${step.id} names no agent.`, 'Add the agent under "agents:", or name one that is there.', { step: step.id });
    }
    for (const edge of stepEdges(step)) {
      if (edge.to !== PROFILE_END && !ids.has(edge.to)) {
        problems.add('EDGE_TARGET_MISSING', `Step ${step.id}, ${edge.chooser === 'you' ? 'choice' : 'outcome'} ${edge.label} points to "${edge.to}", which is not a step.`, `Point it to an existing step, or to "${PROFILE_END}" to end the run.`, { step: step.id, outcome: edge.label });
      }
    }
  }
  if (!ids.has(flow.start)) return;
  const reachable = reachableSteps(flow);
  for (const step of flow.steps) {
    if (!reachable.has(step.id)) {
      problems.add('STEP_UNREACHABLE', `Step ${step.id} can't be reached from ${flow.start}: no outcome, choice or next leads to it.`, `Point an outcome at ${step.id}, or remove the step.`, { step: step.id });
    }
  }
  const ends = flow.steps.some((step) => reachable.has(step.id) && (isTerminalStep(step) || stepEdges(step).some((edge) => edge.to === PROFILE_END)));
  if (!ends) {
    problems.add('FLOW_NO_END', 'No path ends the run: every step leads to another.', `Point an outcome to "${PROFILE_END}", or add a command with no outcomes.`);
  }
}

function readSamples(value: Raw, flow: ProfileFlow | undefined, problems: Problems): ProfileSamples {
  const samples: ProfileSamples = {};
  const raw = asMap(value);
  if (!isAbsent(value) && !raw) {
    problems.add('SAMPLES_SHAPE', '"samples:" is not a set of steps.', 'Write "samples: { <step>: { <outcome>: [ …, … ] } }".');
  }
  for (const [stepId, entry] of Object.entries(raw ?? {})) {
    const outcomes = asMap(entry);
    if (!outcomes) {
      problems.add('SAMPLES_SHAPE', `Samples for step ${stepId} are not a set of outcomes.`, `Write "${stepId}: { <outcome>: [ …, … ] }".`, { step: stepId });
      continue;
    }
    const step = flow?.steps.find((candidate) => candidate.id === stepId);
    if (flow && step?.kind !== 'agent') {
      problems.add('SAMPLES_UNKNOWN_STEP', `Samples are listed for "${stepId}", which is not an agent step.`, 'List samples only under agent steps.', { step: stepId });
    }
    samples[stepId] = {};
    for (const [outcome, entries] of Object.entries(outcomes)) {
      const list = decodeOptionalBoundary(entries, boundary.array(boundary.string));
      if (!list) {
        problems.add('SAMPLES_SHAPE', `Step ${stepId}, outcome ${outcome}: samples are not a list of text.`, 'Write the samples as a list of quoted strings.', { step: stepId, outcome });
        continue;
      }
      if (step?.kind === 'agent' && !step.outcomes.some((edge) => edge.name === outcome)) {
        problems.add('SAMPLES_UNKNOWN_OUTCOME', `Step ${stepId} has samples for "${outcome}", which is not one of its outcomes.`, `Rename it to one of: ${step.outcomes.map((edge) => edge.name).join(', ')}.`, { step: stepId, outcome });
      }
      samples[stepId][outcome] = list;
    }
  }
  for (const step of flow?.steps ?? []) {
    if (step.kind !== 'agent') continue;
    for (const edge of step.outcomes) {
      const count = samples[step.id]?.[edge.name]?.length ?? 0;
      if (count < MIN_SAMPLES_PER_OUTCOME) {
        problems.add('SAMPLES_TOO_FEW', `Step ${step.id}, outcome ${edge.name} has ${count} sample${count === 1 ? '' : 's'}. Every outcome of an agent step needs at least ${MIN_SAMPLES_PER_OUTCOME}, so its picture can show how results vary.`, `Add ${MIN_SAMPLES_PER_OUTCOME - count} more under samples › ${step.id} › ${edge.name}.`, { step: step.id, outcome: edge.name });
      }
    }
  }
  return samples;
}

interface RawRunEntry {
  step: string;
  value?: string;
}

function readRunEntry(raw: JsonValue): RawRunEntry | undefined {
  const bare = text(raw);
  if (bare) return { step: bare };
  const map = asMap(raw);
  const keys = map ? Object.keys(map) : [];
  if (!map || keys.length !== 1) return undefined;
  const value = decodeOptionalBoundary(map[keys[0]], boundary.union(boundary.string, boundary.number));
  return value === undefined ? undefined : { step: keys[0], value: String(value) };
}

function readRuns(value: Raw, flow: ProfileFlow, samples: ProfileSamples, problems: Problems): ProfileExampleRuns {
  const runs: ProfileExampleRuns = {};
  if (isAbsent(value)) return runs;
  const raw = asMap(value);
  if (!raw) {
    problems.add('RUNS_SHAPE', '"runs:" is not a set of named example runs.', 'Write "runs: { A: [ { <step>: <outcome> }, … ] }".');
    return runs;
  }
  const byId = new Map(flow.steps.map((step) => [step.id, step]));
  for (const [runId, entry] of Object.entries(raw)) {
    const list = decodeOptionalBoundary(entry, boundary.array(boundary.json));
    if (!list) {
      problems.add('RUNS_SHAPE', `Example run ${runId} is not a list of steps.`, 'Write it as a list: "- <step>: <outcome>".');
      continue;
    }
    const entries: ProfileRunEntry[] = [];
    let expected: string | undefined = flow.start;
    for (const [index, item] of list.entries()) {
      const where = `Example run ${runId}, entry ${index + 1}`;
      const runEntry = readRunEntry(item);
      if (!runEntry) {
        problems.add('RUN_ENTRY_SHAPE', `${where} is not "<step>: <outcome>" or a step name.`, 'Write it as "- <step>: <outcome>".');
        break;
      }
      const step = byId.get(runEntry.step);
      if (!step) {
        problems.add('RUN_UNKNOWN_STEP', `${where} names "${runEntry.step}", which is not a step.`, 'Use a step from the flow.', { step: runEntry.step });
        break;
      }
      if (runEntry.step !== expected) {
        problems.add('RUN_OFF_FLOW', expected === undefined ? `${where} (${runEntry.step}) comes after the run has ended.` : `${where} goes to ${runEntry.step}, but the flow leads to ${expected}.`, 'Follow the flow\'s arrows from one entry to the next.', { step: runEntry.step });
        break;
      }
      const parsed = parseRunValue(step, runEntry.value, samples, where, problems);
      if (!parsed) break;
      entries.push(parsed.entry);
      expected = parsed.next === PROFILE_END ? undefined : parsed.next;
    }
    runs[runId] = entries;
  }
  return runs;
}

interface ParsedRunValue {
  entry: ProfileRunEntry;
  next: string | undefined;
}

function parseRunValue(step: ProfileStep, value: string | undefined, samples: ProfileSamples, where: string, problems: Problems): ParsedRunValue | undefined {
  if (value === undefined) {
    if (isTerminalStep(step)) return { entry: { step: step.id }, next: undefined };
    problems.add('RUN_NO_OUTCOME', `${where} (${step.id}) says nothing about how the step ended.`, `Write "${step.id}: <outcome>".`, { step: step.id });
    return undefined;
  }
  if (step.kind === 'ask' && step.next) {
    return { entry: { step: step.id, answer: value }, next: step.next };
  }
  const sampleRef = step.kind === 'agent' ? SAMPLE_REF_PATTERN.exec(value) : null;
  const took = sampleRef ? sampleRef[1] : value;
  const edges = step.kind === 'ask' ? step.choices : step.outcomes;
  const edge = edges.find((candidate) => candidate.name === took);
  if (!edge) {
    problems.add('RUN_UNKNOWN_OUTCOME', `${where} takes "${took}" at ${step.id}, which is not one of its ${step.kind === 'ask' ? 'choices' : 'outcomes'}.`, `Use one of: ${edges.map((candidate) => candidate.name).join(', ')}.`, { step: step.id, outcome: took });
    return undefined;
  }
  const entry: ProfileRunEntry = { step: step.id, took };
  if (sampleRef) {
    const sample = Number(sampleRef[2]);
    const count = samples[step.id]?.[took]?.length ?? 0;
    if (sample < 1 || sample > count) {
      problems.add('RUN_UNKNOWN_SAMPLE', `${where} shows sample #${sample} of ${step.id} › ${took}, which has ${count}.`, `Use a number from 1 to ${count}.`, { step: step.id, outcome: took });
      return undefined;
    }
    entry.sample = sample;
  }
  return { entry, next: edge.to };
}
