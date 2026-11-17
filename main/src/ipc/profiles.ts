import type { IpcMain } from 'electron';
import { readFileSync } from 'fs';
import { reasonOf, PaneError } from '../../../shared/paneError';
import type { ProfileDetailView, ProfileLaunchInput, ProfileLibraryView, ProfileRun } from '../../../shared/types/profiles';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { bundledAgentFarmStatus } from '../services/agentFarm/bundledAgentFarm';
import { listOwnAgentFarmProfiles } from '../services/agentFarm/ownAgentFarm';
import { currentProfiles, getProfileRunner } from '../services/profiles/profileRunnerHost';
import { findExecutableInPath } from '../utils/shellPath';
import type { AppServices } from './types';
import { parseRepoSelector, resolveRepoSelector } from './runpane';

const PROFILE_CHANNELS = [
  'profiles:list',
  'profiles:get',
  'profiles:set-enabled',
  'profiles:launch',
  'profiles:runs',
  'profiles:set-outcome',
  'profiles:stop',
] as const;

interface ProfileResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function respond<T>(work: () => T | Promise<T>): Promise<ProfileResponse<T>> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    const next = error instanceof PaneError && error.next ? ` ${error.next}` : '';
    return { success: false, error: `${reasonOf(error)}.${next}` };
  }
}

const launchSchema = boundary.object({
  profile: boundary.nonEmptyString,
  repoId: boundary.number,
  sessionId: boundary.optional(boundary.nonEmptyString),
  sessionName: boundary.optional(boundary.string),
  prompt: boundary.nonEmptyString,
  harness: boundary.optional(boundary.record(boundary.nonEmptyString)),
  commands: boundary.optional(boundary.record(boundary.nonEmptyString)),
});

/** The library, the bundled Agent Farm's state, and the person's own Agent Farm profiles when one is installed. */
async function profileLibraryView(): Promise<ProfileLibraryView> {
  const view: ProfileLibraryView = { profiles: currentProfiles() };
  const status = bundledAgentFarmStatus();
  if (status) {
    view.agentFarm = { state: status.state };
    if (status.version) view.agentFarm.version = status.version;
    if (status.error) view.agentFarm.error = status.error;
  }
  const own = findExecutableInPath('agent-farm');
  if (own) {
    try { view.ownAgentFarm = { profiles: await listOwnAgentFarmProfiles(own) }; }
    catch (error) { view.ownAgentFarm = { profiles: [], error: reasonOf(error) }; }
  }
  return view;
}

/** A run starts in the Session the launch names, or a new one, without starting that Session's own agent. */
async function launchProfile(services: AppServices, input: ProfileLaunchInput): Promise<ProfileRun> {
  const runner = getProfileRunner();
  let sessionId = input.sessionId;
  if (!sessionId) {
    const manager = services.orchestrationSessionManager;
    if (!manager) throw new PaneError('PROFILE_SESSIONS_UNAVAILABLE', 'Sessions are not running in this Pane, so the run has nowhere to live.', 'Restart Pane, then launch again.');
    const wanted = input.sessionName?.trim() || `${input.profile}: ${input.prompt}`.slice(0, 60).trim();
    // Session names are unique: the same task launched again gets "<name> 2", as a handoff does.
    const taken = new Set((await manager.list()).sessions.map((session) => session.name));
    let name = wanted;
    for (let number = 2; taken.has(name); number += 1) name = `${wanted} ${number}`;
    sessionId = (await manager.create({ name })).session.id;
  }
  const request = { profile: input.profile, repoId: input.repoId, sessionId, prompt: input.prompt, harness: input.harness ?? {}, commands: input.commands ?? {} };
  return runner.launch(request);
}

const runpaneLaunchSchema = boundary.object({
  name: boundary.nonEmptyString,
  prompt: boundary.nonEmptyString,
  repo: boundary.optional(boundary.json),
  session: boundary.optional(boundary.nonEmptyString),
  harness: boundary.optional(boundary.nonEmptyString),
  agentHarness: boundary.optional(boundary.record(boundary.nonEmptyString)),
  commands: boundary.optional(boundary.record(boundary.nonEmptyString)),
  callerPanelId: boundary.optional(boundary.string),
});

/** `runpane profiles launch`: the repo by selector, the Session by id or name (new without one), and one CLI for every agent or per agent. */
async function runpaneLaunch(services: AppServices, value: PaneCommandValue): Promise<ProfileRun> {
  const request = decodeBoundary(value, runpaneLaunchSchema);
  const loaded = currentProfiles().find((candidate) => candidate.name === request.name);
  if (!loaded) throw new PaneError('PROFILE_NOT_FOUND', `No profile is named "${request.name}".`, 'Run `runpane profiles list` to see the names.');
  if (loaded.teamOnly && loaded.valid) throw new PaneError('PROFILE_TEAM_ONLY', `${request.name} is team only: it has no workflow to launch.`, 'Launch a profile with a flow; `runpane profiles list` marks them launchable.');
  if (!loaded.launchable) throw new PaneError('PROFILE_NOT_LAUNCHABLE', `${request.name} can't launch: ${loaded.errors[0]?.message ?? 'it is invalid'}`, `${loaded.errors[0]?.fix ?? 'Fix the profile.'} Run \`runpane profiles show ${request.name}\` for every error.`);
  const repo = resolveRepoSelector(services.databaseService.getAllProjects(), request.repo === undefined ? { active: true } : parseRepoSelector(request.repo));
  let sessionId: string | undefined;
  if (request.session) {
    const manager = services.orchestrationSessionManager;
    if (!manager) throw new PaneError('PROFILE_SESSIONS_UNAVAILABLE', 'Sessions are not running in this Pane.', 'Restart Pane, then launch again.');
    const sessions = (await manager.list()).sessions;
    const session = sessions.find((candidate) => candidate.id === request.session) ?? sessions.find((candidate) => candidate.name === request.session);
    if (!session) throw new PaneError('PROFILE_SESSION_NOT_FOUND', `No Session has the id or name "${request.session}".`, 'Run `runpane sessions list`, or leave --session out to start a new Session.');
    sessionId = session.id;
  }
  const harness: Record<string, string> = {};
  for (const agent of loaded.profile?.agents ?? []) if (request.harness) harness[agent.id] = request.harness;
  for (const [agent, cli] of Object.entries(request.agentHarness ?? {})) {
    if (!loaded.profile?.agents.some((candidate) => candidate.id === agent)) throw new PaneError('PROFILE_AGENT_UNKNOWN', `${request.name} has no agent "${agent}".`, `Use one of: ${loaded.profile?.agents.map((candidate) => candidate.id).join(', ')}.`);
    harness[agent] = cli;
  }
  const input: ProfileLaunchInput = { profile: request.name, repoId: repo.id, prompt: request.prompt, harness, commands: request.commands ?? {} };
  if (sessionId) input.sessionId = sessionId;
  return launchProfile(services, input);
}

/** The Profiles page's commands. Daemon-owned like `loops:`, so the desktop and paired clients share them. */
export function registerProfileHandlers(ipcMain: IpcMain, services: AppServices, commandRegistry: PaneCommandRegistry): void {
  commandRegistry.register('profiles:list', () => respond(profileLibraryView));
  commandRegistry.register('profiles:get', (name: PaneCommandValue) => respond((): ProfileDetailView => {
    const wanted = decodeBoundary(name, boundary.nonEmptyString);
    const profile = currentProfiles().find((candidate) => candidate.name === wanted);
    if (!profile) throw new PaneError('PROFILE_NOT_FOUND', `No profile is named "${wanted}".`, 'Pick one from the Profiles list.');
    return { profile, yaml: readFileSync(profile.file, 'utf8') };
  }));
  commandRegistry.register('profiles:set-enabled', (name: PaneCommandValue, enabled: PaneCommandValue) => respond(async () => {
    const wanted = decodeBoundary(name, boundary.nonEmptyString);
    const on = decodeBoundary(enabled, boundary.boolean);
    await services.configManager.updateConfigWith((current) => {
      const names = new Set(current.profiles?.enabled ?? ['greenfield']);
      if (on) names.add(wanted);
      else names.delete(wanted);
      return { profiles: { ...current.profiles, enabled: [...names] } };
    });
    return profileLibraryView();
  }));
  commandRegistry.register('profiles:launch', (input: PaneCommandValue) => respond(() => launchProfile(services, decodeBoundary(input, launchSchema))));
  commandRegistry.register('profiles:runs', () => respond(() => getProfileRunner().list()));
  commandRegistry.register('profiles:set-outcome', (runId: PaneCommandValue, outcome: PaneCommandValue) =>
    respond(() => getProfileRunner().setOutcome(decodeBoundary(runId, boundary.nonEmptyString), decodeBoundary(outcome, boundary.nonEmptyString))));
  commandRegistry.register('profiles:stop', (runId: PaneCommandValue) =>
    respond(() => getProfileRunner().stop(decodeBoundary(runId, boundary.nonEmptyString))));
  commandRegistry.bindChannels(ipcMain, PROFILE_CHANNELS);

  // runpane profiles list | show | launch | runs, and the pane MCP tools of the same names.
  commandRegistry.register('runpane:profiles:list', async () => ({ ok: true, ...(await profileLibraryView()) }));
  commandRegistry.register('runpane:profiles:show', (value: PaneCommandValue) => {
    const { name } = decodeBoundary(value, boundary.object({ name: boundary.nonEmptyString }));
    const profile = currentProfiles().find((candidate) => candidate.name === name);
    if (!profile) throw new PaneError('PROFILE_NOT_FOUND', `No profile is named "${name}".`, 'Run `runpane profiles list` to see the names.');
    return { ok: true, profile, yaml: readFileSync(profile.file, 'utf8') };
  });
  commandRegistry.register('runpane:profiles:launch', async (value: PaneCommandValue) => ({ ok: true, run: await runpaneLaunch(services, value) }));
  commandRegistry.register('runpane:profiles:runs', () => ({ ok: true, runs: getProfileRunner().list() }));
}
