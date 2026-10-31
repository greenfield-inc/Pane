import { describe, expect, it } from 'vitest';

import { RemoteRequestError } from '@shared/remoteClient';
import { revokeGlassesOnComputers } from '@shared/glassesRevoke';
import { decodeGlassesPairingCode } from '@shared/types/glasses';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import type { TailnetMachine } from '@shared/types/workspaceAccess';
import type { JsonValue } from '@shared/validation/boundaryDecoder';

import {
  createGlassesPairingCode,
  glassesDeviceName,
  listGlassesOnComputers,
  pairableComputers,
  type GlassesInvoke,
} from './glassesPairing';

const DOMAIN = 'tail1234.ts.net';
const PHONE = { name: 'Even G2 · iPhone', id: 'pane-native-a' };

function machine(name: string, state: TailnetMachine['state'], mine = true, domain = DOMAIN): TailnetMachine {
  return { name, dnsName: `${name}.${domain}`, url: `https://${name}.${domain}:8443`, os: 'macOS', ownerLogin: 'me@example.com', mine, state };
}

describe('pairableComputers', () => {
  it('pairs with your answering computers, reuses a saved password, and says why it skips the rest', () => {
    const saved: RemotePaneConnectionProfile = {
      id: 'tailnet-tail1234.ts.net-devbox', label: 'devbox', baseUrl: `https://devbox.${DOMAIN}:8443`, token: 'correct horse',
      transport: 'http+sse', tailnetMachine: 'devbox', tailnetDomain: DOMAIN,
    };
    const { computers, skipped } = pairableComputers([
      machine('studio-mac', 'available'),
      machine('devbox', 'password-required'),
      machine('laptop', 'offline'),
      machine('locked', 'password-required'),
      machine('teammate', 'available', false),
    ], DOMAIN, [saved]);

    expect(computers.map(computer => [computer.machine.name, computer.profile.token])).toEqual([['studio-mac', ''], ['devbox', 'correct horse']]);
    expect(skipped).toEqual([
      { name: 'laptop', dnsName: 'laptop.tail1234.ts.net', reason: 'offline' },
      { name: 'locked', dnsName: 'locked.tail1234.ts.net', reason: 'needs its password; connect to it once in Your Computers' },
    ]);
  });
});

describe('createGlassesPairingCode', () => {
  it('packs one secret per answering computer into a code the glasses app reads, expiring with the first secret', async () => {
    const { computers } = pairableComputers([machine('studio-mac', 'available'), machine('devbox', 'available')], DOMAIN, []);
    const asked: unknown[] = [];
    const invoke: GlassesInvoke = async (profile, channel, args) => {
      asked.push([profile.label, channel, args]);
      if (profile.label === 'devbox') throw new Error('Pane on devbox did not answer');
      return { secret: 'pgs_studio', expiresAt: '2026-10-28T08:10:00.000Z' };
    };

    const result = await createGlassesPairingCode(computers, PHONE, invoke);

    expect(asked).toContainEqual(['studio-mac', 'runpane:glasses:create-pairing-secret', [{ deviceName: 'Even G2 · iPhone', phoneId: 'pane-native-a' }]]);
    expect(result.paired).toEqual(['studio-mac']);
    expect(result.skipped).toEqual([{ name: 'devbox', dnsName: 'devbox.tail1234.ts.net', reason: 'Pane on devbox did not answer' }]);
    expect(decodeGlassesPairingCode(result.code ?? '')).toEqual({
      v: 1,
      expiresAt: '2026-10-28T08:10:00.000Z',
      computers: [{ name: 'studio-mac', url: `https://studio-mac.${DOMAIN}:8443`, secret: 'pgs_studio' }],
    });
  });

  it('makes no code when no computer answers', async () => {
    const { computers } = pairableComputers([machine('studio-mac', 'available')], DOMAIN, []);
    const result = await createGlassesPairingCode(computers, PHONE, async () => { throw new Error('offline'); });
    expect(result).toMatchObject({ code: null, paired: [] });
  });
});

describe('revokeGlassesOnComputers', () => {
  it('revokes the glasses this phone paired where it can, by install id, and keeps unreachable computers pending', async () => {
    const { computers } = pairableComputers([machine('studio-mac', 'available'), machine('devbox', 'available')], DOMAIN, []);
    const revoked: string[] = [];
    const invoke: GlassesInvoke = async (profile, channel, args): Promise<JsonValue> => {
      if (profile.label === 'devbox') throw new Error('offline');
      if (channel === 'runpane:glasses:list') {
        return { devices: [
          { id: 'g1', label: 'Even G2 · iPhone', phoneId: 'pane-native-a', createdAt: '2026-10-28T00:00:00.000Z' },
          { id: 'g2', label: 'Even G2 · iPhone', phoneId: 'pane-native-b', createdAt: '2026-10-28T00:00:00.000Z' },
        ] };
      }
      revoked.push(JSON.stringify(args));
      return { revoked: true };
    };

    const result = await revokeGlassesOnComputers(computers, ['laptop.tail1234.ts.net'], 'pane-native-a', invoke);

    expect(revoked).toEqual([JSON.stringify([{ id: 'g1' }])]);
    expect(result).toEqual({ revoked: ['studio-mac'], pending: ['devbox.tail1234.ts.net', 'laptop.tail1234.ts.net'] });
  });

  it('settles a pending revoke only on that computer, never one of the same name on another tailnet', async () => {
    const { computers } = pairableComputers([machine('devbox', 'available', true, 'other5678.ts.net')], 'other5678.ts.net', []);
    const invoke: GlassesInvoke = async () => ({ devices: [] });

    const result = await revokeGlassesOnComputers(computers, ['devbox.tail1234.ts.net'], 'pane-native-a', invoke);

    expect(result.pending).toEqual(['devbox.tail1234.ts.net']);
  });
});

describe('a computer running a Pane without glasses support', () => {
  const olderPane: GlassesInvoke = async () => { throw new RemoteRequestError('Unknown channel', 404, 'ERR_UNKNOWN_CHANNEL'); };
  const { computers } = pairableComputers([machine('old-mac', 'available')], DOMAIN, []);

  it('says to update Pane there, when listing and pairing', async () => {
    expect(await listGlassesOnComputers(computers, 'pane-native-a', olderPane)).toEqual([{ name: 'old-mac', device: null, problem: 'update Pane there to use glasses' }]);
    expect((await createGlassesPairingCode(computers, PHONE, olderPane)).skipped).toEqual([{ name: 'old-mac', dnsName: 'old-mac.tail1234.ts.net', reason: 'update Pane there to use glasses' }]);
  });

  it('is never left pending a revoke, since it never held the glasses', async () => {
    expect(await revokeGlassesOnComputers(computers, ['old-mac.tail1234.ts.net'], 'pane-native-a', olderPane)).toEqual({ revoked: [], pending: [] });
  });
});

describe('glassesDeviceName', () => {
  it('names the glasses after the phone', () => {
    expect(glassesDeviceName('Parsa\'s iPhone', 'ios')).toBe('Even G2 · Parsa\'s iPhone');
    expect(glassesDeviceName(undefined, 'android')).toBe('Even G2 · Android phone');
  });
});
