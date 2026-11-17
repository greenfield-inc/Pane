import type { IpcMain } from 'electron';
import { readFileSync } from 'fs';
import { reasonOf, PaneError } from '../../../shared/paneError';
import type { OwnAgentFarmView, ProfileDetailView, ProfileLaunchInput, ProfileLibraryView, ProfileRun } from '../../../shared/types/profiles';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { bundledAgentFarmStatus } from '../services/agentFarm/bundledAgentFarm';
import { listOwnAgentFarmProfiles } from '../services/agentFarm/ownAgentFarm';
import { currentProfiles, getProfileRunner } from '../services/profiles/profileRunnerHost';
import { findExecutableInPath } from '../utils/shellPath';
import type { AppServices } from './types';

const PROFILE_CHANNELS = [
  'profiles:list',
  'profiles:own-agent-farm',
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

/** The library and the bundled Agent Farm's state. Reads files only, so every caller (the + menu included) gets it at once. */
function profileLibraryView(): ProfileLibraryView {
  const view: ProfileLibraryView = { profiles: currentProfiles() };
  const status = bundledAgentFarmStatus();
  if (status) {
    view.agentFarm = { state: status.state };
    if (status.version) view.agentFarm.version = status.version;
    if (status.error) view.agentFarm.error = status.error;
  }
  return view;
}

/** The person's own Agent Farm profiles, listed by running their agent-farm (up to 30 s); null when none is installed. */
async function ownAgentFarmView(): Promise<OwnAgentFarmView | null> {
  const own = findExecutableInPath('agent-farm');
  if (!own) return null;
  try { return { profiles: await listOwnAgentFarmProfiles(own) }; }
  catch (error) { return { profiles: [], error: reasonOf(error) }; }
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

/** The Profiles page's commands. Daemon-owned like `loops:`, so the desktop and paired clients share them. */
export function registerProfileHandlers(ipcMain: IpcMain, services: AppServices, commandRegistry: PaneCommandRegistry): void {
  commandRegistry.register('profiles:list', () => respond(profileLibraryView));
  commandRegistry.register('profiles:own-agent-farm', () => respond(ownAgentFarmView));
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
      const names = new Set(decodeOptionalBoundary(current.profiles?.enabled, boundary.array(boundary.string)) ?? ['greenfield']);
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
}
