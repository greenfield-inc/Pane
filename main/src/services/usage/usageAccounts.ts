import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { UsageAccount, UsageProvider } from '../../../../shared/types/usage';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

const claudeAccountSchema = boundary.object({
  oauthAccount: boundary.object({
    accountUuid: boundary.nonEmptyString,
    organizationUuid: boundary.optional(boundary.nullable(boundary.string)),
    emailAddress: boundary.optional(boundary.nullable(boundary.string)),
    planDisplayName: boundary.optional(boundary.nullable(boundary.string)),
  }),
});

const codexAuthSchema = boundary.object({
  tokens: boundary.object({
    account_id: boundary.optional(boundary.nullable(boundary.string)),
    id_token: boundary.optional(boundary.nullable(boundary.string)),
  }),
});

const codexClaimsSchema = boundary.object({
  email: boundary.optional(boundary.nullable(boundary.string)),
  'https://api.openai.com/auth': boundary.optional(boundary.object({
    chatgpt_account_id: boundary.optional(boundary.nullable(boundary.string)),
    chatgpt_user_id: boundary.optional(boundary.nullable(boundary.string)),
    chatgpt_plan_type: boundary.optional(boundary.nullable(boundary.string)),
  })),
});

function readJson(path: string): JsonValue | undefined {
  try {
    const parsed: JsonValue = JSON.parse(readFileSync(path, 'utf8'));
    return parsed;
  } catch {
    return undefined;
  }
}

function jwtClaims(token: string | null | undefined): JsonValue | undefined {
  const payload = token?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims: JsonValue = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims;
  } catch {
    return undefined;
  }
}

type Identity = Omit<UsageAccount, 'provider'>;

function claudeAccount(home: string): Identity | null {
  const config = decodeOptionalBoundary(readJson(join(home, '.claude.json')), claudeAccountSchema);
  if (!config) return null;
  const account = config.oauthAccount;
  return {
    key: `${account.accountUuid}:${account.organizationUuid ?? ''}`,
    label: account.emailAddress || 'Claude account',
    plan: account.planDisplayName || null,
  };
}

function codexAccount(home: string): Identity | null {
  const auth = decodeOptionalBoundary(readJson(join(home, '.codex', 'auth.json')), codexAuthSchema);
  if (!auth) return null;
  const claims = decodeOptionalBoundary(jwtClaims(auth.tokens.id_token), codexClaimsSchema);
  const openai = claims?.['https://api.openai.com/auth'];
  const workspace = auth.tokens.account_id || openai?.chatgpt_account_id;
  if (!workspace) return null;
  return {
    key: `${workspace}:${openai?.chatgpt_user_id ?? ''}`,
    label: claims?.email || 'ChatGPT account',
    plan: openai?.chatgpt_plan_type || null,
  };
}

/**
 * The Claude Code and Codex accounts this machine is signed in to, read from the same home
 * the transcripts come from. Only the identity leaves this machine: an id, an email and a plan,
 * never a token. Two machines with the same `key` share one account and its limits.
 */
export function readUsageAccounts(home = homedir()): UsageAccount[] {
  const identities = { claude: claudeAccount(home), codex: codexAccount(home) } satisfies Record<UsageProvider, Identity | null>;
  const isProvider = (key: string): key is UsageProvider => Object.hasOwn(identities, key);
  return Object.entries(identities).flatMap(([provider, identity]) => (identity && isProvider(provider) ? [{ provider, ...identity }] : []));
}
