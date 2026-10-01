import { describe, expect, it } from 'vitest';
import {
  authorizePeerInvoke,
  framePeerMessage,
  PeerRateLimiter,
  stripControlCharacters,
  type PeerSessionInfo,
} from './peerPolicy';

const sessionB: PeerSessionInfo = {
  id: 'session-b',
  name: 'Session B',
  archived: false,
  internalSessionId: 'pane-b',
  orchestratorPanelId: 'panel-orch-b',
};
const sessionC: PeerSessionInfo = {
  id: 'session-c',
  name: 'Session C',
  archived: false,
  internalSessionId: 'pane-c',
  orchestratorPanelId: 'panel-orch-c',
};
const peerA = { id: 'peer-a', label: 'Session A', allowedSessionIds: ['session-b'] };

describe('authorizePeerInvoke', () => {
  it('frames a submit to an allowlisted Session orchestrator panel', () => {
    const decision = authorizePeerInvoke(peerA, 'runpane:panels:submit', [
      { panelId: 'panel-orch-b', input: 'please rebase', idempotencyKey: 'k1' },
    ], [sessionB, sessionC]);
    expect(decision).toEqual({
      ok: true,
      args: [{ panelId: 'panel-orch-b', input: '[peer message from Session A] please rebase', agentOnly: true, idempotencyKey: 'k1' }],
    });
  });

  it('refuses a submit to any other panel, including shells', () => {
    const decision = authorizePeerInvoke(peerA, 'runpane:panels:submit', [
      { panelId: 'panel-shell-b', input: 'rm -rf /' },
    ], [sessionB]);
    expect(decision).toMatchObject({ ok: false, statusCode: 403, code: 'ERR_PEER_PANEL_FORBIDDEN' });
  });

  it('refuses the orchestrator panel of a Session that does not allowlist the peer', () => {
    const decision = authorizePeerInvoke(peerA, 'runpane:panels:submit', [
      { panelId: 'panel-orch-c', input: 'hi' },
    ], [sessionB, sessionC]);
    expect(decision).toMatchObject({ ok: false, statusCode: 403, code: 'ERR_PEER_PANEL_FORBIDDEN' });
  });

  it('refuses every channel for a peer on no allowlist', () => {
    const unlisted = { id: 'peer-x', label: 'X', allowedSessionIds: [] };
    for (const channel of ['runpane:panels:submit', 'runpane:panels:list', 'runpane:workspace:wait']) {
      expect(authorizePeerInvoke(unlisted, channel, [{ panelId: 'panel-orch-b', input: 'x' }], [sessionB]))
        .toMatchObject({ ok: false, statusCode: 403, code: 'ERR_PEER_NOT_ALLOWLISTED' });
    }
  });

  it('treats an archived Session as not allowlisting anyone', () => {
    const decision = authorizePeerInvoke(peerA, 'runpane:panels:submit', [
      { panelId: 'panel-orch-b', input: 'hi' },
    ], [{ ...sessionB, archived: true }]);
    expect(decision).toMatchObject({ ok: false, code: 'ERR_PEER_NOT_ALLOWLISTED' });
  });

  it('refuses channels outside the peer list', () => {
    for (const channel of ['runpane:report', 'runpane:panels:input', 'runpane:panes:create', 'runpane:peers:mint', 'mobile:push-register']) {
      expect(authorizePeerInvoke(peerA, channel, [{}], [sessionB]))
        .toMatchObject({ ok: false, statusCode: 403, code: 'ERR_PEER_CHANNEL_FORBIDDEN' });
    }
  });

  it('scopes panels:list to the allowlisted Session and its orchestrator panel', () => {
    const decision = authorizePeerInvoke(peerA, 'runpane:panels:list', [], [sessionB, sessionC]);
    expect(decision).toMatchObject({ ok: true, args: [{ paneId: 'pane-b' }] });
    expect(decision.ok && [...(decision.panelFilter ?? [])]).toEqual(['panel-orch-b']);
    expect(authorizePeerInvoke(peerA, 'runpane:panels:list', [{ paneId: 'pane-c' }], [sessionB, sessionC]))
      .toMatchObject({ ok: false, code: 'ERR_PEER_NOT_ALLOWLISTED' });
  });

  it('asks for a Session when several allowlist the peer', () => {
    const both = { ...peerA, allowedSessionIds: ['session-b', 'session-c'] };
    expect(authorizePeerInvoke(both, 'runpane:panels:list', [{}], [sessionB, sessionC]))
      .toMatchObject({ ok: false, statusCode: 400, code: 'ERR_PEER_SESSION_REQUIRED' });
    expect(authorizePeerInvoke(both, 'runpane:panels:list', [{ session: 'Session C' }], [sessionB, sessionC]))
      .toMatchObject({ ok: true, args: [{ paneId: 'pane-c' }] });
  });

  it('forces workspace:wait onto the Session and namespaces its cursor', () => {
    const decision = authorizePeerInvoke(peerA, 'runpane:workspace:wait', [{ as: 'watcher', timeoutMs: 1000 }], [sessionB]);
    expect(decision).toEqual({
      ok: true,
      args: [{ as: 'peer.peera.watcher', timeoutMs: 1000, session: 'session-b' }],
    });
    expect(authorizePeerInvoke(peerA, 'runpane:workspace:wait', [{ paneIds: ['pane-x'] }], [sessionB]))
      .toMatchObject({ ok: false, code: 'ERR_PEER_SCOPE_FORBIDDEN' });
  });
});

describe('framePeerMessage', () => {
  it('strips terminal control characters and sanitizes the label', () => {
    expect(framePeerMessage('A]\n[admin', 'go\u001b[2J\u0003 now\nline2\tx')).toBe('[peer message from A admin] go[2J now\nline2\tx');
    expect(stripControlCharacters('a\u0000b\u007fc\u009bd\re')).toBe('abcd\re');
  });

  it('names an unlabelled peer', () => {
    expect(framePeerMessage('\u0007', 'hi')).toBe('[peer message from unnamed peer] hi');
  });
});

describe('PeerRateLimiter', () => {
  it('allows the limit per window per peer', () => {
    let now = 0;
    const limiter = new PeerRateLimiter(2, 1000, () => now);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(true);
    expect(limiter.tryAcquire('a')).toBe(false);
    expect(limiter.tryAcquire('b')).toBe(true);
    now = 1000;
    expect(limiter.tryAcquire('a')).toBe(true);
  });
});
