import { RemoteAuthError } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import type { TailnetMachine, TailnetMachineList } from '@shared/types/workspaceAccess';
import { boundary, decodeBoundary, type BoundarySchema } from '@shared/validation/boundaryDecoder';

/** Port of the Workspaces listener that serves codeless connections. */
const WORKSPACES_PORT = 8443;
const NAME_HINT = 'Use the full name from Pane on that computer, like studio-mac.tail1234.ts.net.';

export interface ComputerAddress {
  url: string;
  name: string;
  domain: string;
}

/**
 * What a person typed into "Find your computers": the address Pane shows under Settings ›
 * Remote Access › Address on a computer. A phone can't read `tailscale status`, so one computer's
 * full Tailscale name is how it finds the rest.
 */
export function parseComputerAddress(input: string): ComputerAddress | { error: string } {
  const trimmed = input.trim().replace(/\/+$/, '').toLowerCase();
  if (!trimmed) return { error: 'Enter the address shown in Pane on that computer.' };
  const match = /^(?:https:\/\/)?([a-z0-9-]+)\.([a-z0-9-]+\.ts\.net)(?::(\d{1,5}))?$/.exec(trimmed);
  if (!match) return { error: NAME_HINT };
  const [, name, domain, port] = match;
  return { url: `https://${name}.${domain}:${port ?? WORKSPACES_PORT}`, name, domain };
}

/** A computer saved from the list: reached over Tailscale, bound to its tailnet. */
export function codelessProfile(machine: TailnetMachine, domain: string, password = ''): RemotePaneConnectionProfile {
  return {
    id: `tailnet-${domain}-${machine.name}`.toLowerCase(),
    label: machine.name,
    baseUrl: machine.url,
    token: password,
    transport: 'http+sse',
    tailnetMachine: machine.name,
    tailnetDomain: domain,
  };
}

/** A throwaway profile for asking a typed-in computer for the list. */
export function directoryProfile(address: ComputerAddress): RemotePaneConnectionProfile {
  return {
    id: `tailnet-${address.domain}-${address.name}`,
    label: address.name,
    baseUrl: address.url,
    token: '',
    transport: 'http+sse',
    tailnetMachine: address.name,
    tailnetDomain: address.domain,
  };
}

const machineSchema: BoundarySchema<TailnetMachine> = boundary.object({
  name: boundary.nonEmptyString,
  dnsName: boundary.nonEmptyString,
  url: boundary.nonEmptyString,
  os: boundary.enumeration('macOS', 'Windows', 'Linux'),
  ownerLogin: boundary.string,
  mine: boundary.boolean,
  state: boundary.enumeration('available', 'password-required', 'outdated', 'unreachable', 'offline'),
  visibility: boundary.optional(boundary.enumeration('owner', 'tailnet')),
  paneVersion: boundary.optional(boundary.string),
  profileId: boundary.optional(boundary.string),
});
const machineListSchema: BoundarySchema<TailnetMachineList> = boundary.union(
  boundary.object({
    ok: boundary.literal(true),
    tailnet: boundary.string,
    domain: boundary.nonEmptyString,
    machines: boundary.array(machineSchema),
  }),
  boundary.object({ ok: boundary.literal(false), reason: boundary.string, fix: boundary.string }),
);

/** The answer to `runpane:workspaces:machines`, checked before it reaches the screen. */
export function decodeMachineList(value: unknown): TailnetMachineList {
  return decodeBoundary(value, machineListSchema);
}

/** Whether a failed connect needs the password typed in, or a different one. */
export function passwordProblem(error: unknown): 'required' | 'invalid' | null {
  if (!(error instanceof RemoteAuthError)) return null;
  if (error.code === 'ERR_WORKSPACE_PASSWORD_REQUIRED') return 'required';
  if (error.code === 'ERR_WORKSPACE_PASSWORD_INVALID') return 'invalid';
  return null;
}
