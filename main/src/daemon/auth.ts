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

type WorkspaceAuthResult = { ok: true; client: null } | RemoteDaemonAuthFailure;

/** Who may reach the workspace listener right now. */
export interface WorkspaceAccessPolicy {
  ownerLogin: string;
  /** "owner": only `ownerLogin`. "tailnet": any login in `tailnetLogins`. */
  visibility: 'owner' | 'tailnet';
  /** Lowercased logins of the people with untagged devices in the current tailnet. */
  tailnetLogins: ReadonlySet<string>;
  /** Checks a presented password or token; null when password protection is off. */
  verifySecret: ((secret: string) => boolean) | null;
}

/**
 * The codeless access check: the login must be allowed by visibility, and then, when password
 * protection is on, the request must carry the password. Visibility comes first, so a refused
 * login learns nothing about the password.
 *
 * Tailscale Serve (proxy mode) sets `Tailscale-User-Login` for user-owned devices, including
 * users a device was shared with, and strips any copy the caller sent; tagged devices get none.
 */
export function authenticateWorkspaceRequest(
  loginHeader: string | string[] | undefined,
  authorizationHeader: string | string[] | undefined,
  policy: WorkspaceAccessPolicy | null,
): WorkspaceAuthResult {
  // Serve sends exactly one login; a repeated header is not Serve's.
  const login = Array.isArray(loginHeader) ? '' : (loginHeader ?? '').trim().toLowerCase();
  if (!login) {
    return workspaceAuthFailure(
      403,
      'ERR_WORKSPACE_IDENTITY_REQUIRED',
      'This machine accepts only requests that Tailscale Serve signs with a user login; tagged devices are refused.',
    );
  }
  const allowed = policy !== null && (
    login === policy.ownerLogin.toLowerCase()
    || (policy.visibility === 'tailnet' && policy.tailnetLogins.has(login))
  );
  if (!allowed) {
    return workspaceAuthFailure(
      403,
      'ERR_WORKSPACE_IDENTITY_REFUSED',
      policy?.visibility === 'tailnet'
        ? `This machine accepts people on its tailnet; ${login} is not one of them.`
        : `This machine accepts only its owner's Tailscale login; ${login} is refused.`,
    );
  }
  if (policy.verifySecret) {
    const secret = extractBearerToken(authorizationHeader);
    if (!secret) {
      return workspaceAuthFailure(401, 'ERR_WORKSPACE_PASSWORD_REQUIRED', 'This machine is password protected; enter its password to connect.');
    }
    if (!policy.verifySecret(secret)) {
      return workspaceAuthFailure(401, 'ERR_WORKSPACE_PASSWORD_INVALID', 'The password for this machine is wrong.');
    }
  }
  return { ok: true, client: null };
}

function workspaceAuthFailure(statusCode: number, code: string, message: string): RemoteDaemonAuthFailure {
  return { ok: false, statusCode, error: { message, code } };
}
