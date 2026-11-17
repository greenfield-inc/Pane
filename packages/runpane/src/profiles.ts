import { boundary, decodeBoundary, type BoundarySchema, type JsonObject } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon } from './daemonClient';
import { confirmMutation } from './daemonActions';
import { RunpaneError } from './errors';
import { paneListResultSchema } from './localControl';

/**
 * `runpane profiles list|show|launch|runs`: Pane's profile library and the runs it follows. Each
 * prints the daemon's JSON unchanged with --json (the MCP tools return the same), and a readable
 * summary otherwise. The Python CLI's profiles.py prints the same lines.
 */

/** The repo selector `panes create` takes, as Pane resolves it. */
type RepoSelector = string | { id: number } | { active: true };

interface ProfileLaunchRequest {
  name: string;
  prompt: string;
  repo: RepoSelector;
  session?: string;
  harness?: string;
  agentHarness?: Record<string, string>;
  commands?: Record<string, string>;
  callerPanelId?: string;
}

/** What each profiles channel takes: nothing (list, runs), a name (show), or a launch. */
type ProfilesRequest = Record<string, never> | { name: string } | ProfileLaunchRequest;

const problemSchema = boundary.object({ code: boundary.string, message: boundary.string, fix: boundary.string });
const edgeSchema = boundary.object({ name: boundary.string, to: boundary.string });
const stepSchema = boundary.object({
  id: boundary.string,
  kind: boundary.string,
  title: boundary.optional(boundary.string),
  agent: boundary.optional(boundary.string),
  outcomes: boundary.optional(boundary.array(edgeSchema)),
  choices: boundary.optional(boundary.array(edgeSchema)),
  next: boundary.optional(boundary.string),
});
/** The parts of a normalized profile the text output names. */
const profileBodySchema = boundary.object({
  agents: boundary.array(boundary.object({ id: boundary.string, runs: boundary.string })),
  flow: boundary.optional(boundary.object({ start: boundary.string, steps: boundary.array(stepSchema) })),
});
const libraryProfileSchema = boundary.object({
  name: boundary.string,
  version: boundary.optional(boundary.string),
  title: boundary.optional(boundary.string),
  origin: boundary.string,
  file: boundary.string,
  valid: boundary.boolean,
  launchable: boundary.boolean,
  teamOnly: boundary.boolean,
  enabled: boundary.boolean,
  errors: boundary.array(problemSchema),
  profile: boundary.optional(profileBodySchema),
});
type LibraryProfileView = ReturnType<typeof libraryProfileSchema.decode>;
const runSchema = boundary.object({
  id: boundary.string,
  profile: boundary.string,
  sessionId: boundary.string,
  paneId: boundary.optional(boundary.string),
  state: boundary.string,
  step: boundary.string,
  error: boundary.optional(boundary.string),
  attention: boundary.optional(boundary.string),
});
type RunView = ReturnType<typeof runSchema.decode>;
const listViewSchema = boundary.object({
  ok: boundary.literal(true),
  profiles: boundary.array(libraryProfileSchema),
  agentFarm: boundary.optional(boundary.object({ state: boundary.string, version: boundary.optional(boundary.string), error: boundary.optional(boundary.string) })),
  ownAgentFarm: boundary.optional(boundary.object({
    profiles: boundary.array(boundary.object({ name: boundary.string })),
    error: boundary.optional(boundary.string),
  })),
});
const showViewSchema = boundary.object({ ok: boundary.literal(true), profile: libraryProfileSchema, yaml: boundary.string });
const launchViewSchema = boundary.object({ ok: boundary.literal(true), run: runSchema });
const runsViewSchema = boundary.object({ ok: boundary.literal(true), runs: boundary.array(runSchema) });

/** Asks Pane, and returns its JSON as sent (for --json) with the fields the text output reads. */
async function invokeProfiles<View>(parsed: ParsedArgs, channel: string, request: ProfilesRequest, view: BoundarySchema<View>): Promise<{ raw: JsonObject; view: View }> {
  const raw = await invokeDaemon(channel, [request], boundary.jsonObject, { paneDir: parsed.paneDir });
  return { raw, view: decodeBoundary(raw, view) };
}

export async function runProfilesList(parsed: ParsedArgs): Promise<number> {
  const { raw, view } = await invokeProfiles(parsed, 'runpane:profiles:list', {}, listViewSchema);
  if (parsed.json) {
    printJson(raw);
    return 0;
  }
  if (view.profiles.length === 0) console.log('No profiles.');
  for (const profile of view.profiles) console.log(profileLine(profile));
  if (view.agentFarm && view.agentFarm.state !== 'ready') {
    const version = view.agentFarm.version ? ` ${view.agentFarm.version}` : '';
    console.log(`Agent Farm${version}: ${view.agentFarm.state}${view.agentFarm.error ? ` (${view.agentFarm.error})` : ''}`);
  }
  if (view.ownAgentFarm) {
    const names = view.ownAgentFarm.profiles.map((profile) => profile.name).join(', ') || 'no profiles';
    console.log(`Your Agent Farm: ${names}${view.ownAgentFarm.error ? ` (${view.ownAgentFarm.error})` : ''}`);
  }
  return 0;
}

export async function runProfilesShow(parsed: ParsedArgs): Promise<number> {
  const name = requireProfileName(parsed);
  const { raw, view } = await invokeProfiles(parsed, 'runpane:profiles:show', { name }, showViewSchema);
  if (parsed.json) {
    printJson(raw);
    return 0;
  }
  if (parsed.yaml) {
    process.stdout.write(view.yaml.endsWith('\n') ? view.yaml : `${view.yaml}\n`);
    return 0;
  }
  for (const line of describeProfile(view.profile)) console.log(line);
  return 0;
}

export async function runProfilesLaunch(parsed: ParsedArgs): Promise<number> {
  const name = requireProfileName(parsed);
  const prompt = parsed.initialInput;
  if (prompt === undefined || !prompt.trim()) {
    throw new RunpaneError(
      'ERR_PROFILES_PROMPT_REQUIRED',
      `runpane profiles launch needs --prompt: what you want done, which the profile's first agent step gets. Nothing was launched.`,
      `Run \`runpane profiles launch ${name} --prompt "<what you want done>" --yes\`.`,
    );
  }
  await confirmMutation(parsed);
  const request: ProfileLaunchRequest = { name, prompt, repo: await launchRepo(parsed) };
  const session = parsed.sessionId?.trim() || process.env.PANE_ORCHESTRATION_SESSION_ID?.trim();
  if (session) request.session = session;
  if (parsed.profileHarness?.trim()) request.harness = parsed.profileHarness.trim();
  if (parsed.agentHarness) request.agentHarness = parsed.agentHarness;
  if (parsed.profileCommands) request.commands = parsed.profileCommands;
  const callerPanelId = process.env.PANE_PANEL_ID?.trim();
  if (callerPanelId) request.callerPanelId = callerPanelId;
  const { raw, view } = await invokeProfiles(parsed, 'runpane:profiles:launch', request, launchViewSchema);
  if (parsed.json) printJson(raw);
  else console.log(describeLaunch(view.run));
  return view.run.state === 'failed' ? 1 : 0;
}

export async function runProfilesRuns(parsed: ParsedArgs): Promise<number> {
  const { raw, view } = await invokeProfiles(parsed, 'runpane:profiles:runs', {}, runsViewSchema);
  if (parsed.json) {
    printJson(raw);
    return 0;
  }
  if (view.runs.length === 0) console.log('No profile runs. Start one with `runpane profiles launch <name> --prompt <text> --yes`.');
  for (const run of view.runs) console.log(`${run.id} · ${run.profile} · ${run.state} · step ${run.step}${run.error ? ` · ${run.error}` : ''}${run.attention ? ` · ${run.attention}` : ''}`);
  return 0;
}

function requireProfileName(parsed: ParsedArgs): string {
  const name = parsed.profileName?.trim();
  if (name) return name;
  throw new RunpaneError(
    'ERR_PROFILES_NAME_REQUIRED',
    `runpane ${parsed.command} needs the profile's name as its first word. Nothing was ${parsed.command === 'profiles launch' ? 'launched' : 'shown'}.`,
    `See names with \`runpane profiles list\`, then run \`runpane ${parsed.command} <name>\`.`,
  );
}

/**
 * --repo; else the repo of the Pane this terminal runs in ($PANE_SESSION_ID), as Pane lists it;
 * else the active repo (also when Pane does not list that Pane).
 */
async function launchRepo(parsed: ParsedArgs): Promise<RepoSelector> {
  if (parsed.repo?.trim()) return parsed.repo.trim();
  const paneId = process.env.PANE_SESSION_ID?.trim();
  if (paneId) {
    const listed = await invokeDaemon('runpane:panes:list', [{}], paneListResultSchema, { paneDir: parsed.paneDir });
    const pane = listed.panes.find((candidate) => candidate.id === paneId);
    if (pane) return { id: pane.repoId };
  }
  return { active: true };
}

function profileState(profile: LibraryProfileView): string {
  if (!profile.valid) return `invalid: ${profile.errors[0]?.message ?? 'no reason given'}`;
  if (profile.teamOnly) return 'team only';
  return profile.launchable ? 'launchable' : 'not launchable';
}

function profileLine(profile: LibraryProfileView): string {
  return `${profile.name} ${profile.version ?? '-'} · ${profile.origin} · ${profile.enabled ? 'on' : 'off'} · ${profileState(profile)}`;
}

function describeProfile(profile: LibraryProfileView): string[] {
  const lines = [profileLine(profile)];
  if (profile.title) lines.push(profile.title);
  lines.push(`File: ${profile.file}`);
  const body = profile.profile;
  if (body) {
    lines.push('', 'Agents:');
    for (const agent of body.agents) lines.push(`  ${agent.id}  runs ${agent.runs}`);
    if (body.flow) {
      lines.push('', `Steps (start: ${body.flow.start}):`);
      for (const step of body.flow.steps) {
        const who = step.agent ? ` ${step.agent}` : '';
        lines.push(`  ${step.id} (${step.kind}${who})${step.title ? `: ${step.title}` : ''}`);
        for (const edge of [...(step.outcomes ?? []), ...(step.choices ?? [])]) lines.push(`    ${edge.name} → ${edge.to}`);
        if (step.next) lines.push(`    (answer) → ${step.next}`);
      }
    } else {
      lines.push('', 'Steps: none (a team only, with no workflow to launch)');
    }
  }
  if (profile.errors.length > 0) {
    lines.push('', 'Errors:');
    for (const error of profile.errors) lines.push(`  ${error.code}: ${error.message} Fix: ${error.fix}`);
  }
  return lines;
}

function describeLaunch(run: RunView): string {
  const pane = run.paneId ? ` in Pane ${run.paneId}` : '';
  if (run.state === 'failed') return `Run ${run.id} of ${run.profile} failed at step ${run.step}: ${run.error ?? 'no reason given'}`;
  return `Started run ${run.id} of ${run.profile} in Session ${run.sessionId}: step ${run.step}${pane}.${run.attention ? ` ${run.attention}` : ''}`;
}

function printJson(value: JsonObject): void {
  console.log(JSON.stringify(value, null, 2));
}
