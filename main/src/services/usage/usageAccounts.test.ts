import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { readUsageAccounts } from './usageAccounts';

const homes: string[] = [];
function home(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'usage-accounts-'));
  homes.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** An unsigned JWT with these claims, as Codex stores its id token. */
const jwt = (claims: JsonObject) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('readUsageAccounts', () => {
  it('names the Claude Code and Codex accounts without any token', () => {
    const dir = home({
      '.claude.json': JSON.stringify({ oauthAccount: { accountUuid: 'acc-1', organizationUuid: 'org-1', emailAddress: 'me@example.com', planDisplayName: 'Max' }, projects: {} }),
      '.codex/auth.json': JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          account_id: 'ws-9', access_token: 'secret-access', refresh_token: 'secret-refresh',
          id_token: jwt({ email: 'me@example.com', 'https://api.openai.com/auth': { chatgpt_user_id: 'user-4', chatgpt_plan_type: 'pro' } }),
        },
      }),
    });

    const accounts = readUsageAccounts(dir);

    expect(accounts).toEqual([
      { provider: 'claude', key: 'acc-1:org-1', label: 'me@example.com', plan: 'Max' },
      { provider: 'codex', key: 'ws-9:user-4', label: 'me@example.com', plan: 'pro' },
    ]);
    expect(JSON.stringify(accounts)).not.toContain('secret');
  });

  it('reports no account for a machine that is not signed in', () => {
    const dir = home({
      '.claude.json': JSON.stringify({ projects: {} }),
      '.codex/auth.json': JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: null }),
    });
    expect(readUsageAccounts(dir)).toEqual([]);
    expect(readUsageAccounts(join(dir, 'missing'))).toEqual([]);
  });
});
