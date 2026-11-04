import { describe, expect, it } from 'vitest';
import { moveTargets, moveToHostPrompt, sessionHostFor } from './moveSessionToHost';
import type { TailnetMachine, TailnetMachineList } from '../../../shared/types/workspaceAccess';
import type { RemoteDaemonConfig } from '../../../shared/types/remoteDaemon';

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

describe('sessionHostFor', () => {
  const profile: RemoteDaemonConfig['client']['profiles'][number] = { id: 'mini', label: 'Mini', baseUrl: 'https://mini:8443', token: '', transport: 'http+sse' };
  const config = (mode: 'local' | 'remote', profiles: RemoteDaemonConfig['client']['profiles']): Pick<RemoteDaemonConfig, 'client'> =>
    ({ client: { mode, activeProfileId: 'mini', profiles } });

  it('is this computer while the app shows its own Pane', () => {
    expect(sessionHostFor(config('local', [{ ...profile, tailnetMachine: 'tylers-mac-mini' }]))).toEqual({ kind: 'local' });
    expect(sessionHostFor(undefined)).toEqual({ kind: 'local' });
  });

  it('is the Tailscale machine of a codeless host', () => {
    expect(sessionHostFor(config('remote', [{ ...profile, tailnetMachine: 'tylers-mac-mini' }])))
      .toEqual({ kind: 'tailnet', machine: 'tylers-mac-mini' });
  });

  it('cannot be placed for a host paired with a code, and says why', () => {
    const host = sessionHostFor(config('remote', [profile]));
    expect(host.kind).toBe('paired');
    expect(host.kind === 'paired' && host.reason).toMatch(/pairing code.*Tailscale/);
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
