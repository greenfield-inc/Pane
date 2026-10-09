import { describe, expect, it } from 'vitest';

import { RemoteAuthError } from '@shared/remoteClient';
import type { TailnetMachine } from '@shared/types/workspaceAccess';

import { codelessProfile, decodeMachineList, directoryProfile, parseComputerAddress, passwordProblem } from './computers';

describe('parseComputerAddress', () => {
  it('takes a Tailscale name as shown in Pane on the computer, with or without scheme and port', () => {
    expect(parseComputerAddress('studio-mac.tail1234.ts.net')).toEqual({ url: 'https://studio-mac.tail1234.ts.net:8443', name: 'studio-mac', domain: 'tail1234.ts.net' });
    expect(parseComputerAddress('  https://Studio-Mac.tail1234.ts.net:8444/ ')).toEqual({ url: 'https://studio-mac.tail1234.ts.net:8444', name: 'studio-mac', domain: 'tail1234.ts.net' });
  });

  it('explains what to type when the address is not a full Tailscale name', () => {
    expect(parseComputerAddress('studio-mac')).toEqual({ error: 'Use the full name from Pane on that computer, like studio-mac.tail1234.ts.net.' });
    expect(parseComputerAddress('http://studio-mac.tail1234.ts.net')).toEqual({ error: 'Use the full name from Pane on that computer, like studio-mac.tail1234.ts.net.' });
    expect(parseComputerAddress('')).toEqual({ error: 'Enter the address shown in Pane on that computer.' });
  });
});

describe('codelessProfile', () => {
  const machine: TailnetMachine = {
    name: 'studio-mac', dnsName: 'studio-mac.tail1234.ts.net', url: 'https://studio-mac.tail1234.ts.net:8443',
    os: 'macOS', ownerLogin: 'me@example.com', mine: true, state: 'available',
  };

  it('saves a computer as a codeless profile bound to its tailnet', () => {
    expect(codelessProfile(machine, 'tail1234.ts.net')).toEqual({
      id: 'tailnet-tail1234.ts.net-studio-mac',
      label: 'studio-mac',
      baseUrl: 'https://studio-mac.tail1234.ts.net:8443',
      token: '',
      transport: 'http+sse',
      tailnetMachine: 'studio-mac',
      tailnetDomain: 'tail1234.ts.net',
    });
    expect(codelessProfile(machine, 'tail1234.ts.net', 'correct horse').token).toBe('correct horse');
  });

  it('builds a profile to ask a computer for the list, from a typed address', () => {
    const address = parseComputerAddress('studio-mac.tail1234.ts.net:8444');
    if ('error' in address) throw new Error(address.error);
    expect(directoryProfile(address)).toMatchObject({ baseUrl: 'https://studio-mac.tail1234.ts.net:8444', token: '', tailnetMachine: 'studio-mac', tailnetDomain: 'tail1234.ts.net' });
  });
});

describe('decodeMachineList', () => {
  it('accepts the host list and refuses anything else', () => {
    const list = { ok: true, tailnet: 'me.github', domain: 'tail1234.ts.net', machines: [{ name: 'a', dnsName: 'a.tail1234.ts.net', url: 'https://a.tail1234.ts.net:8443', os: 'Linux', ownerLogin: 'me', mine: true, state: 'offline' }] };
    expect(decodeMachineList(list)).toEqual(list);
    expect(decodeMachineList({ ok: false, reason: 'Tailscale is signed out', fix: 'Open Tailscale and sign in.' })).toMatchObject({ ok: false });
    expect(() => decodeMachineList({ machines: 'nope' })).toThrow();
  });
});

describe('passwordProblem', () => {
  it('tells a missing password from a wrong one, and ignores other failures', () => {
    expect(passwordProblem(new RemoteAuthError('x', 'ERR_WORKSPACE_PASSWORD_REQUIRED'))).toBe('required');
    expect(passwordProblem(new RemoteAuthError('x', 'ERR_WORKSPACE_PASSWORD_INVALID'))).toBe('invalid');
    expect(passwordProblem(new RemoteAuthError('x', 'ERR_WORKSPACE_IDENTITY_REFUSED'))).toBeNull();
    expect(passwordProblem(new Error('offline'))).toBeNull();
  });
});
