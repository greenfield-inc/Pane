/**
 * Secrets in cloud Sessions (D-58). The person's computers send their merged Pane secrets and the
 * GitHub and agent sign-ins to each cloud Session VM they hold a link to, never through Greenfield's
 * service. A VM is receive-only (D-75): nothing comes back from it.
 */
import { CONFIGURED_AGENT_IDS, configuredAgent, type ConfiguredAgentId } from '../agents';

/** The Pane secret project that holds the sign-ins a cloud VM exports to its agents. */
export const CLOUD_SIGN_IN_PROJECT = 'pane-cloud';

/** The person's `gh auth token`, read on a desktop when it sends; the GitHub CLI and git read it as GH_TOKEN. */
export const GITHUB_SIGN_IN_ENV = 'GH_TOKEN';

/** An agent a cloud VM signs in with a long-lived token the person makes once on a desktop, and the env var it reads. */
export interface CloudTokenAgent {
  id: ConfiguredAgentId;
  title: string;
  env: string;
  /** What the person runs on a desktop to make the token, such as `claude setup-token`. */
  command: string;
}

/** Agents with a sign-in token (Claude Code's `setup-token`), from the agents config. */
export const CLOUD_TOKEN_AGENTS: readonly CloudTokenAgent[] = CONFIGURED_AGENT_IDS.flatMap((id) => {
  const agent = configuredAgent(id);
  return agent.signInToken ? [{ id, title: agent.title, env: agent.signInToken.env, command: [agent.executables[0], ...agent.signInToken.args].join(' ') }] : [];
});

/** Every sign-in a cloud VM puts in its agents' environment. */
export const CLOUD_SIGN_IN_ENVS: readonly string[] = [GITHUB_SIGN_IN_ENV, ...CLOUD_TOKEN_AGENTS.map((agent) => agent.env)];

/** What the person turned off in "Choose what to send". It syncs to all their computers and their cloud VMs. */
export interface PaneCloudSecretChoice {
  /** Secrets by `<project>/<NAME>`. */
  excludedSecrets: string[];
  /** Machines by the name a secret records as where it was last set. */
  excludedMachines: string[];
}

export const EMPTY_PANE_CLOUD_SECRET_CHOICE: PaneCloudSecretChoice = { excludedSecrets: [], excludedMachines: [] };

/** One secret in the chooser: its name and what it is for, never its value. */
export interface PaneCloudSecretItem {
  key: string;
  name: string;
  /** The secret's project, or what a sign-in is for ("GitHub", "Claude Code"). */
  label: string;
}

/** A machine the person's secrets were last set on, with those secrets. */
export interface PaneCloudSecretMachine {
  name: string;
  /** The computer this window runs on. */
  thisComputer: boolean;
  secrets: PaneCloudSecretItem[];
}

export interface PaneCloudSecrets {
  machines: PaneCloudSecretMachine[];
  choice: PaneCloudSecretChoice;
  /** Agents whose sign-in token is not saved yet: the Pane Cloud card asks for each once. */
  missingTokens: CloudTokenAgent[];
}

/** Whether the person's choice sends a secret last set on `machine`. */
export function sendsToCloud(choice: PaneCloudSecretChoice, key: string, machine: string): boolean {
  return !choice.excludedSecrets.includes(key) && !choice.excludedMachines.includes(machine);
}
