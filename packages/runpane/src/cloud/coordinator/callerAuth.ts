import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Caller tokens for the coordinator's HTTP API: `rpc1.<callerId>.<base64url HMAC-SHA256(secret, "rpc1:" + callerId)>`.
// The coordinator stores no per-caller state: it recomputes the MAC. Revocation is a
// `revokedCallers` config entry, or rotating the secret for everyone. Peer tokens (callerId = a cloud
// Session id) are also only valid while that Session is in the directory.

const PREFIX = 'rpc1';
const CALLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;

type CallerRole = 'user' | 'peer';

export interface Caller {
  id: string;
  role: CallerRole;
}

export function createCallerSecret(): string {
  return randomBytes(32).toString('base64url');
}

function callerRole(callerId: string): CallerRole {
  return callerId.startsWith('user:') ? 'user' : 'peer';
}

function mac(secret: string, callerId: string): string {
  return createHmac('sha256', secret).update(`${PREFIX}:${callerId}`).digest('base64url');
}

export function mintCallerToken(secret: string, callerId: string): string {
  if (!CALLER_ID_PATTERN.test(callerId)) {
    throw new Error('caller id must be 1-128 characters of letters, digits, ":", "_" or "-"');
  }
  return `${PREFIX}.${callerId}.${mac(secret, callerId)}`;
}

export type CallerAuthResult =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403; code: string; message: string };

export async function authenticateCaller(
  authorization: string | undefined,
  options: { secret: string; revokedCallers: readonly string[]; isKnownPeer: (callerId: string) => Promise<boolean> },
): Promise<CallerAuthResult> {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
  if (!match) return { ok: false, status: 401, code: 'auth-required', message: 'coordinator bearer token is required' };
  const parts = match[1].split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !CALLER_ID_PATTERN.test(parts[1])) {
    return { ok: false, status: 403, code: 'auth-invalid', message: 'coordinator token is invalid' };
  }
  const [, callerId, presented] = parts;
  const expected = Buffer.from(mac(options.secret, callerId));
  const actual = Buffer.from(presented);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, status: 403, code: 'auth-invalid', message: 'coordinator token is invalid' };
  }
  if (options.revokedCallers.includes(callerId)) {
    return { ok: false, status: 403, code: 'auth-revoked', message: `caller ${callerId} is revoked` };
  }
  const role = callerRole(callerId);
  if (role === 'peer' && !(await options.isKnownPeer(callerId))) {
    return { ok: false, status: 403, code: 'auth-unknown-peer', message: `caller ${callerId} is not a cloud Session in the directory` };
  }
  return { ok: true, caller: { id: callerId, role } };
}
