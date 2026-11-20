import { describe, expect, it } from 'vitest';
import type { RemoteDaemonClientRecord } from '../../../shared/types/remoteDaemon';
import { authenticateRemoteDaemonBearerToken, hashRemoteDaemonToken, isWorkspaceRequestAdmitted, type WorkspaceAccessPolicy } from './auth';

function createClientRecord(id: string, token: string): RemoteDaemonClientRecord {
  return {
    id,
    label: `Client ${id}`,
    createdAt: new Date('2026-05-14T00:00:00.000Z').toISOString(),
    tokenHash: hashRemoteDaemonToken(token),
  };
}

describe('remote daemon auth', () => {
  it('authenticates matching bearer tokens against paired clients', () => {
    const result = authenticateRemoteDaemonBearerToken(
      'Bearer secret-token',
      [createClientRecord('client-1', 'secret-token')],
    );

    expect(result).toEqual({
      ok: true,
      client: createClientRecord('client-1', 'secret-token'),
    });
  });

  it('rejects missing bearer tokens', () => {
    expect(authenticateRemoteDaemonBearerToken(undefined, [createClientRecord('client-1', 'secret-token')])).toEqual({
      ok: false,
      statusCode: 401,
      error: {
        message: 'Remote daemon bearer token is required',
        code: 'ERR_REMOTE_DAEMON_AUTH_REQUIRED',
      },
    });
  });

  it('rejects invalid bearer tokens', () => {
    expect(authenticateRemoteDaemonBearerToken('Bearer wrong-token', [createClientRecord('client-1', 'secret-token')])).toEqual({
      ok: false,
      statusCode: 403,
      error: {
        message: 'Remote daemon bearer token is invalid',
        code: 'ERR_REMOTE_DAEMON_AUTH_INVALID',
      },
    });
  });

  it('rejects malformed authorization schemes', () => {
    expect(authenticateRemoteDaemonBearerToken('Basic abc123', [createClientRecord('client-1', 'secret-token')])).toEqual({
      ok: false,
      statusCode: 401,
      error: {
        message: 'Remote daemon bearer token is required',
        code: 'ERR_REMOTE_DAEMON_AUTH_REQUIRED',
      },
    });
  });
});

describe('isWorkspaceRequestAdmitted', () => {
  const policy = (overrides: Partial<WorkspaceAccessPolicy> = {}): WorkspaceAccessPolicy => ({
    ownerLogin: 'owner@example.com',
    visibility: 'owner',
    tailnetLogins: new Set(['owner@example.com', 'teammate@example.com']),
    verifySecret: null,
    ...overrides,
  });

  it('applies the same visibility check as a new request', () => {
    expect(isWorkspaceRequestAdmitted('Owner@Example.com', undefined, policy())).toBe(true);
    expect(isWorkspaceRequestAdmitted('teammate@example.com', undefined, policy())).toBe(false);
    expect(isWorkspaceRequestAdmitted('teammate@example.com', undefined, policy({ visibility: 'tailnet' }))).toBe(true);
    expect(isWorkspaceRequestAdmitted(undefined, undefined, policy())).toBe(false);
    expect(isWorkspaceRequestAdmitted('owner@example.com', undefined, null)).toBe(false);
  });

  it('counts a password only once a check proved it, and never runs a check itself', () => {
    let checks = 0;
    const verifySecret = {
      check: () => { checks += 1; return 'valid' as const; },
      isProved: (secret: string) => secret === 'proved',
    };
    expect(isWorkspaceRequestAdmitted('owner@example.com', 'Bearer proved', policy({ verifySecret }))).toBe(true);
    expect(isWorkspaceRequestAdmitted('owner@example.com', 'Bearer unproved', policy({ verifySecret }))).toBe(false);
    expect(isWorkspaceRequestAdmitted('owner@example.com', undefined, policy({ verifySecret }))).toBe(false);
    expect(checks).toBe(0);
  });
});
