import type { AppConfig } from '../../types/config';

/**
 * Profiles (T-63) is off by default: one switch, Settings › Advanced › Experimental › Profiles,
 * saved as `sessionProfilesEnabled`. This is the one place main reads it. While it is off, Pane
 * behaves as it did before T-63: no `agent-farm` shim in Pane's terminals, chat profiles and
 * Session moves use the person's own agent-farm first, and Agent Farm telemetry follows Agent
 * Farm's own default. The removed Profiles engine's `profilesEnabled` key is never read: a Pane
 * that had it on still has it saved, and that must not turn this on.
 */
export function profilesEnabled(config: Pick<AppConfig, 'sessionProfilesEnabled'> | undefined | null): boolean {
  return config?.sessionProfilesEnabled === true;
}

let readConfig: () => Pick<AppConfig, 'sessionProfilesEnabled'> | undefined = () => undefined;

/** Startup points the switch at the live config once; until then (and in tests that don't) Profiles reads as off. */
export function readProfilesSwitchFrom(read: () => Pick<AppConfig, 'sessionProfilesEnabled'> | undefined): void {
  readConfig = read;
}

/** The switch, for code without a config of its own at hand (chat launches, Session moves). */
export function profilesOn(): boolean {
  return profilesEnabled(readConfig());
}
