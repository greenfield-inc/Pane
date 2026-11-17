import { describe, expect, it } from 'vitest';
import { moveBlockedReason, moveTargets, moveToHostPrompt, sessionHostFor, sessionHostForMachine } from './moveSessionToHost';
import type { TailnetMachine, TailnetMachineList } from '../../../shared/types/workspaceAccess';
import type { RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { ComputerRoute, RemoteComputer } from '../../../shared/types/remoteComputers';

function machine(name: string, overrides: Partial<TailnetMachine> = {}): TailnetMachine {
  return {
    name,
    dnsName: `${name}.tail1234.ts.net`,
    url: `https://${name}.tail1234.ts.net:8443`,
    os: 'macOS',
    ownerLogin: 'tyler@github',
    mine: true,
    state: 'available',
    ...overrides,
  };
}

function list(...machines: TailnetMachine[]): TailnetMachineList {
  return { ok: true, tailnet: 'example.github', domain: 'tail1234.ts.net', machines };
}

describe('moveToHostPrompt', () => {
  it('asks the Session agent to run the existing handoff to the chosen machine', () => {
    expect(moveToHostPrompt('codex', 'tylers-mac-mini')).toBe(
      'Hand this Session off to codex on tylers-mac-mini. Use the handoff skill: write the note from '
      + '`runpane handoff --template`, check it with `--dry-run`, then run '
      + '`runpane handoff "codex on tylers-mac-mini" --note-file <note>` from this Session\'s folder. '
      + 'Don\'t push anything. Tell me the Session it created.',
    );
  });
});

const tailscaleRoute: ComputerRoute = {
  id: 'tailscale:https://tylers-mac-mini.tail1234.ts.net:8443', kind: 'tailscale', source: 'found',
  baseUrl: 'https://tylers-mac-mini.tail1234.ts.net:8443', token: '', tailnetMachine: 'tylers-mac-mini', tailnetDomain: 'tail1234.ts.net',
};
const relayRoute: ComputerRoute = {
  id: 'relay:https://mini.runpane.net', kind: 'relay', source: 'link', baseUrl: 'https://mini.runpane.net', token: 'synthetic',
  relay: { computerId: 'mini', fingerprint: 'f' },
};
const mini = (routes: ComputerRoute[]): RemoteComputer => ({ id: 'mini', label: 'Mini', routes });

describe('sessionHostFor', () => {
  const config = (mode: 'local' | 'remote', computers: RemoteComputer[]): Pick<RemoteDaemonConfig, 'client'> =>
    ({ client: { mode, activeProfileId: 'mini', computers, profiles: [] } });

  it('is this computer while the app shows its own Pane', () => {
    expect(sessionHostFor(config('local', [mini([tailscaleRoute])]))).toEqual({ kind: 'local' });
    expect(sessionHostFor(undefined)).toEqual({ kind: 'local' });
  });

  it('is the Tailscale machine of a computer with a Tailscale route, whatever route is first', () => {
    expect(sessionHostFor(config('remote', [mini([relayRoute, tailscaleRoute])])))
      .toEqual({ kind: 'tailnet', machine: 'tylers-mac-mini' });
  });

  it('cannot be placed for a computer without a Tailscale route, and says why', () => {
    const host = sessionHostFor(config('remote', [mini([relayRoute])]));
    expect(host.kind).toBe('paired');
    expect(host.kind === 'paired' && host.reason).toMatch(/no Tailscale route.*Tailscale/);
  });
});

describe('sessionHostForMachine', () => {
  // The window shows this computer; All machines rows still name their own machine.
  const config = (computers: RemoteComputer[]): Pick<RemoteDaemonConfig, 'client'> =>
    ({ client: { mode: 'local', activeProfileId: null, computers, profiles: [] } });

  it('is this computer for a row on this computer, whichever host the window shows', () => {
    expect(sessionHostForMachine(config([mini([tailscaleRoute])]), 'local')).toEqual({ kind: 'local' });
  });

  it('is the Tailscale machine of the row\'s saved computer, not the host on screen', () => {
    expect(sessionHostForMachine(config([mini([tailscaleRoute])]), 'mini'))
      .toEqual({ kind: 'tailnet', machine: 'tylers-mac-mini' });
  });

  it('cannot be placed for a computer without Tailscale or no longer saved, and says why', () => {
    const paired = sessionHostForMachine(config([mini([relayRoute])]), 'mini');
    expect(paired.kind === 'paired' && paired.reason).toMatch(/^Mini has no Tailscale route/);
    const gone = sessionHostForMachine(config([]), 'mini');
    expect(gone.kind === 'paired' && gone.reason).toMatch(/no longer has this machine saved/);
  });
});

describe('moveBlockedReason', () => {
  it('lets a Session on a placed, connected host move', () => {
    expect(moveBlockedReason({ kind: 'local' })).toBeNull();
    expect(moveBlockedReason({ kind: 'tailnet', machine: 'build-box' }, { name: 'build-box', status: 'online' })).toBeNull();
  });

  it('says why a paired host cannot move a Session', () => {
    expect(moveBlockedReason({ kind: 'paired', reason: 'Paired.' }, { name: 'mini', status: 'online' })).toBe('Paired.');
  });

  it('says a machine that is not connected cannot be asked, and how to get it back', () => {
    expect(moveBlockedReason({ kind: 'tailnet', machine: 'travel-laptop' }, { name: 'travel-laptop', status: 'offline' }))
      .toBe('travel-laptop is offline, so its Session\'s agent can\'t be asked to hand off. Use Retry on travel-laptop, then try again once it is back.');
    expect(moveBlockedReason({ kind: 'tailnet', machine: 'build-box' }, { name: 'build-box', status: 'connecting' }))
      .toMatch(/^build-box is still connecting/);
  });
});

describe('moveTargets', () => {
  it('leaves out the machine the Session lives on and keeps this computer as a target', () => {
    const result = moveTargets({
      machines: list(machine('tylers-mac-mini'), machine('build-box')),
      sessionHost: { kind: 'tailnet', machine: 'tylers-mac-mini' },
      thisComputer: { name: 'tylers-macbook', available: true },
    });
    expect(result.ok && result.targets.map(target => [target.name, target.available])).toEqual([
      ['tylers-macbook', true],
      ['build-box', true],
    ]);
  });

  it('shows machines that cannot take the Session as disabled, with the reason', () => {
    const result = moveTargets({
      machines: list(
        machine('tylers-mac-mini'),
        machine('tylers-mac-mini-1', { state: 'offline' }),
        machine('closed-pane', { state: 'unreachable' }),
        machine('locked', { state: 'password-required' }),
        machine('old', { state: 'outdated' }),
        machine('teammate-offline', { mine: false, ownerLogin: 'sam@github', state: 'offline' }),
        machine('teammate-private', { mine: false, ownerLogin: 'sam@github', state: 'refused' }),
      ),
      sessionHost: { kind: 'local' },
    });
    if (!result.ok) throw new Error('expected targets');
    expect(result.targets.map(target => [target.name, target.available, target.reason])).toEqual([
      ['tylers-mac-mini', true, undefined],
      ['tylers-mac-mini-1', false, 'Offline'],
      ['closed-pane', false, expect.stringMatching(/Pane is not open/)],
      ['locked', false, expect.stringMatching(/password/)],
      ['old', false, expect.stringMatching(/older Pane/)],
      ['teammate-offline', false, 'Offline'],
      ['teammate-private', false, 'Accepts only its owner\'s Tailscale login; they can set Who can connect → Everyone on tailnet'],
    ]);
    expect(result.noneReachable).toBe(false);
  });

  it('offers a teammate\'s machine that accepts this login, with its owner', () => {
    const result = moveTargets({
      machines: list(machine('tylers-mac-mini'), machine('parsa-devbox', { mine: false, ownerLogin: 'parsakhaz@github', visibility: 'tailnet' })),
      sessionHost: { kind: 'local' },
    });
    if (!result.ok) throw new Error('expected targets');
    expect(result.targets).toEqual([
      { name: 'tylers-mac-mini', os: 'macOS', available: true },
      { name: 'parsa-devbox', os: 'macOS', owner: 'parsakhaz@github', available: true },
    ]);
  });

  it('lets a teammate\'s machine be the only reachable target', () => {
    const result = moveTargets({
      machines: list(machine('parsa-devbox', { mine: false, ownerLogin: 'parsakhaz@github' })),
      sessionHost: { kind: 'local' },
    });
    expect(result.ok && result.noneReachable).toBe(false);
  });

  it('says so, with the fix, when no machine can take the Session', () => {
    const result = moveTargets({ machines: list(machine('tylers-mac-mini', { state: 'offline' })), sessionHost: { kind: 'local' } });
    expect(result.ok && result.noneReachable).toBe(true);
    const empty = moveTargets({ machines: list(), sessionHost: { kind: 'local' } });
    expect(empty.ok && empty.noneReachable).toBe(true);
  });

  it('passes on why Tailscale cannot list machines', () => {
    expect(moveTargets({ machines: { ok: false, reason: 'Tailscale is signed out', fix: 'Sign in to Tailscale.' }, sessionHost: { kind: 'local' } }))
      .toEqual({ ok: false, reason: 'Tailscale is signed out', fix: 'Sign in to Tailscale.' });
  });
});
