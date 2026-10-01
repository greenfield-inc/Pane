import { describe, expect, it } from 'vitest';
import {
  createDefaultRemoteDaemonConfig,
  decodePaneRemoteConnection,
  normalizeRemoteDaemonConfig,
} from '../../../../shared/types/remoteDaemon';
import { authenticateRemoteDaemonBearerToken } from '../auth';
import { listPeers, mintPeerRecord, revokePeer, setPeerSessionAccess } from './peerRecords';

const access = { baseUrl: 'https://rp-bbbb.tail.ts.net', updatedAt: '2026-09-30T00:00:00.000Z' };

describe('peer records', () => {
  it('mints a peer record whose code authenticates as a peer and survives config normalization', () => {
    const minted = mintPeerRecord(createDefaultRemoteDaemonConfig(), {
      label: 'Session A',
      allowedSessionIds: ['session-b', 'session-b'],
      access,
    });
    const config = normalizeRemoteDaemonConfig(JSON.parse(JSON.stringify(minted.config)));
    const code = decodePaneRemoteConnection(minted.connectionCode);
    expect(code).toMatchObject({ label: 'Session A', baseUrl: access.baseUrl });

    const auth = authenticateRemoteDaemonBearerToken(`Bearer ${code.token}`, config.host.clients);
    expect(auth).toMatchObject({ ok: true, client: { scope: 'peer', allowedSessionIds: ['session-b'], label: 'Session A' } });
    expect(minted.peer).not.toHaveProperty('tokenHash');
  });

  it('starts with an empty allowlist and allows, denies and revokes by label or id', () => {
    const minted = mintPeerRecord(createDefaultRemoteDaemonConfig(), { label: 'Session A', allowedSessionIds: [], access });
    expect(minted.peer.allowedSessionIds).toEqual([]);

    const allowed = setPeerSessionAccess(minted.config, 'Session A', 'session-b', true);
    expect(listPeers(allowed.config, 'session-b').map(peer => peer.id)).toEqual([minted.peer.id]);
    const denied = setPeerSessionAccess(allowed.config, minted.peer.id, 'session-b', false);
    expect(listPeers(denied.config, 'session-b')).toEqual([]);

    const revoked = revokePeer(denied.config, minted.peer.id);
    expect(revoked.config.host.clients).toEqual([]);
    expect(() => revokePeer(revoked.config, minted.peer.id)).toThrow(/No peer/);
  });

  it('never treats a full client as a peer', () => {
    const config = createDefaultRemoteDaemonConfig();
    config.host.clients = [{ id: 'desk', label: 'Desk', createdAt: 'now', tokenHash: 'ab' }];
    expect(listPeers(config)).toEqual([]);
    expect(() => setPeerSessionAccess(config, 'Desk', 's', true)).toThrow(/No peer/);
  });
});
