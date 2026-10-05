import { describe, expect, it } from 'vitest';
import { readTailnetSelf } from './workspaceHost';

const running = {
  BackendState: 'Running',
  CertDomains: ['parsas-macbook-pro.taila5e94c.ts.net'],
  Self: { DNSName: 'parsas-macbook-pro.taila5e94c.ts.net.', UserID: 31, Tags: null },
  User: { 31: { LoginName: 'owner@example.com' }, 99: { LoginName: 'teammate@example.com' } },
};

describe('readTailnetSelf', () => {
  it('learns the owner and the machine name from the Self entry', () => {
    expect(readTailnetSelf(JSON.stringify(running))).toEqual({
      ok: true,
      ownerLogin: 'owner@example.com',
      machineName: 'parsas-macbook-pro',
      dnsName: 'parsas-macbook-pro.taila5e94c.ts.net',
    });
  });

  it('names the one step that fixes a signed-out Tailscale or a tailnet without HTTPS certificates', () => {
    expect(readTailnetSelf(JSON.stringify({ ...running, BackendState: 'NeedsLogin' }))).toMatchObject({
      ok: false, reason: 'Tailscale is signed out', fix: expect.stringContaining('sign in'),
    });
    expect(readTailnetSelf(JSON.stringify({ ...running, CertDomains: null }))).toMatchObject({
      ok: false, reason: expect.stringContaining('HTTPS certificates'), fix: expect.stringContaining('https://login.tailscale.com/admin/dns'),
    });
  });

  it('has no owner on a tagged machine', () => {
    expect(readTailnetSelf(JSON.stringify({ ...running, Self: { ...running.Self, Tags: ['tag:server'] } }))).toMatchObject({
      ok: false, reason: expect.stringContaining('tagged'),
    });
  });
});
