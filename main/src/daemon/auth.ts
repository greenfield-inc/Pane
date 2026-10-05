import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { RemoteDaemonClientRecord } from '../../../shared/types/remoteDaemon';

interface RemoteDaemonAuthSuccess {
  ok: true;
  client: RemoteDaemonClientRecord;
}

interface RemoteDaemonAuthFailure {
  ok: false;
  statusCode: number;
  error: {
    message: string;
    code: string;
  };
}

export type RemoteDaemonAuthResult = RemoteDaemonAuthSuccess | RemoteDaemonAuthFailure;

export function createRemoteDaemonToken(): string {
  return randomBytes(24).toString('hex');
}

export function hashRemoteDaemonToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function authenticateRemoteDaemonBearerToken(
  authorizationHeader: string | string[] | undefined,
  clients: readonly RemoteDaemonClientRecord[],
): RemoteDaemonAuthResult {
  const token = extractBearerToken(authorizationHeader);
  if (!token) {
    return {
      ok: false,
      statusCode: 401,
      error: {
        message: 'Remote daemon bearer token is required',
        code: 'ERR_REMOTE_DAEMON_AUTH_REQUIRED',
      },
    };
  }

  const tokenHash = hashRemoteDaemonToken(token);
  const client = clients.find((candidate) => safeTokenHashEquals(candidate.tokenHash, tokenHash));
  if (!client) {
    return {
      ok: false,
      statusCode: 403,
      error: {
        message: 'Remote daemon bearer token is invalid',
        code: 'ERR_REMOTE_DAEMON_AUTH_INVALID',
      },
    };
  }

  return {
    ok: true,
    client,
  };
}

function extractBearerToken(authorizationHeader: string | string[] | undefined): string | null {
  if (Array.isArray(authorizationHeader)) {
    return authorizationHeader.length === 1
      ? extractBearerToken(authorizationHeader[0])
      : null;
  }

  if (authorizationHeader === undefined) {
    return null;
  }

  const [scheme, ...rest] = authorizationHeader.trim().split(/\s+/);
  if (scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

function safeTokenHashEquals(expectedHash: string, actualHash: string): boolean {
  try {
    const expected = Buffer.from(expectedHash, 'hex');
    const actual = Buffer.from(actualHash, 'hex');

    if (expected.length === 0 || expected.length !== actual.length) {
      return false;
    }

    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

type WorkspaceIdentityResult = { ok: true; client: null } | RemoteDaemonAuthFailure;

/**
 * Tailscale Serve (proxy mode) sets `Tailscale-User-Login` for user-owned devices and strips any
 * copy the caller sent; tagged devices get no identity. Only the machine owner's login passes.
 */
export function authenticateWorkspaceIdentity(
  loginHeader: string | string[] | undefined,
  ownerLogin: string | null,
): WorkspaceIdentityResult {
  // Serve sends exactly one login; a repeated header is not Serve's.
  const login = Array.isArray(loginHeader) ? '' : (loginHeader ?? '').trim();
  if (!login) {
    return {
      ok: false,
      statusCode: 403,
      error: {
        message: 'Workspaces accept only requests that Tailscale Serve signs with a user login; tagged devices are refused.',
        code: 'ERR_WORKSPACE_IDENTITY_REQUIRED',
      },
    };
  }
  if (!ownerLogin || login.toLowerCase() !== ownerLogin.toLowerCase()) {
    return {
      ok: false,
      statusCode: 403,
      error: {
        message: `This machine's workspace trusts only its owner's Tailscale login; ${login} is refused.`,
        code: 'ERR_WORKSPACE_IDENTITY_REFUSED',
      },
    };
  }
  return { ok: true, client: null };
}
