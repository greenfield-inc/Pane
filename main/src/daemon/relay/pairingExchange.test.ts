import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { authenticateRemoteDaemonBearerToken } from '../auth';
import { PairingExchange } from './pairingExchange';
import type { RemoteDaemonClientRecord } from '../../../../shared/types/remoteDaemon';

const PHONE = '192.168.1.40';
const ATTACKER = '198.51.100.7';

function setup() {
  let now = Date.parse('2026-11-14T08:00:00Z');
  const saved: RemoteDaemonClientRecord[] = [];
  const logs: string[] = [];
  const exchange = new PairingExchange({
    now: () => now,
    addClient: async (record) => { saved.push(record); },
    log: (line) => logs.push(line),
  });
  return { exchange, saved, logs, advance: (ms: number) => { now += ms; } };
}

describe('QR pairing exchange', () => {
  it('trades a secret once for a per-phone token whose hash is saved', async () => {
    const { exchange, saved } = setup();
    const { secret } = exchange.createSecret();
    const result = await exchange.exchange({ secret, label: 'Ana’s iPhone', source: PHONE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(saved).toHaveLength(1);
    expect(saved[0].label).toBe('Ana’s iPhone');
    expect(saved[0].tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'));
    expect(await exchange.exchange({ secret, label: 'Second phone', source: PHONE })).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_USED' });
  });

  it('refuses a secret after 10 minutes', async () => {
    const { exchange, advance } = setup();
    const { secret } = exchange.createSecret();
    advance(10 * 60_000 + 1);
    expect(await exchange.exchange({ secret, label: 'Phone', source: PHONE })).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_EXPIRED' });
  });

  it('locks out a source for 15 minutes after five wrong secrets from it in a minute, while other sources still pair', async () => {
    const { exchange, logs, advance } = setup();
    const { secret } = exchange.createSecret();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await exchange.exchange({ secret: `wrong-${attempt}`, label: 'Phone', source: ATTACKER })).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_INVALID' });
    }
    expect(await exchange.exchange({ secret, label: 'Phone', source: ATTACKER })).toMatchObject({ ok: false, code: 'ERR_PAIRING_LOCKED' });
    expect(logs.some((line) => line.includes(ATTACKER) && line.includes('15 minutes'))).toBe(true);

    expect(await exchange.exchange({ secret, label: 'Owner phone', source: PHONE })).toMatchObject({ ok: true });

    advance(15 * 60_000 + 1);
    expect(await exchange.exchange({ secret: 'wrong-again', label: 'Phone', source: ATTACKER })).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_INVALID' });
  });

  it('counts only wrong secrets within the last minute', async () => {
    const { exchange, advance } = setup();
    const { secret } = exchange.createSecret();
    for (let attempt = 0; attempt < 4; attempt += 1) await exchange.exchange({ secret: `wrong-${attempt}`, label: 'Phone', source: PHONE });
    advance(60_001);
    await exchange.exchange({ secret: 'wrong-late', label: 'Phone', source: PHONE });
    expect(await exchange.exchange({ secret, label: 'Phone', source: PHONE })).toMatchObject({ ok: true });
  });

  it('gives each link its own expiry: 10 minutes, 1 hour or 24 hours', async () => {
    const { exchange, advance } = setup();
    const tenMinutes = exchange.createSecret('10m').secret;
    const hour = exchange.createSecret('1h').secret;
    const day = exchange.createSecret('24h').secret;
    const dayLate = exchange.createSecret('24h').secret;

    advance(11 * 60_000);
    expect(await exchange.exchange({ secret: tenMinutes, label: 'Phone', source: PHONE })).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_EXPIRED' });
    advance(39 * 60_000); // 50 minutes
    expect(await exchange.exchange({ secret: hour, label: 'Phone', source: PHONE })).toMatchObject({ ok: true });

    const hourLate = exchange.createSecret('1h').secret;
    advance(61 * 60_000);
    expect(await exchange.exchange({ secret: hourLate, label: 'Phone', source: PHONE })).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_EXPIRED' });

    advance(23 * 60 * 60_000 - 111 * 60_000); // 23 hours after the day links were made
    expect(await exchange.exchange({ secret: day, label: 'Phone', source: PHONE })).toMatchObject({ ok: true });
    advance(60 * 60_000 + 1);
    expect(await exchange.exchange({ secret: dayLate, label: 'Phone', source: PHONE })).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_EXPIRED' });
  });

  it('still says a 24-hour link was already used when it is tried again near its end', async () => {
    const { exchange, advance } = setup();
    const { secret } = exchange.createSecret('24h');
    advance(60_000);
    expect(await exchange.exchange({ secret, label: 'Phone', source: PHONE })).toMatchObject({ ok: true });
    advance(23 * 60 * 60_000);
    expect(await exchange.exchange({ secret, label: 'Phone', source: PHONE })).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_USED', message: expect.stringContaining('This code was already used') });
  });

  it('checks a secret without spending it, behind the same lockout', async () => {
    const { exchange } = setup();
    const { secret, expiresAt } = exchange.createSecret('1h');
    expect(exchange.check(secret, PHONE)).toEqual({ ok: true, expiresAt });
    expect(exchange.check(secret, PHONE)).toEqual({ ok: true, expiresAt });
    expect(await exchange.exchange({ secret, label: 'Phone', source: PHONE })).toMatchObject({ ok: true });
    expect(exchange.check(secret, PHONE)).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_USED' });

    for (let attempt = 0; attempt < 5; attempt += 1) exchange.check(`wrong-${attempt}`, ATTACKER);
    expect(exchange.check(exchange.createSecret().secret, ATTACKER)).toMatchObject({ ok: false, code: 'ERR_PAIRING_LOCKED' });
  });

  it('keeps 16 secrets waiting: a new one retires the oldest 10-minute one before a longer link', async () => {
    const { exchange } = setup();
    const longLink = exchange.createSecret('24h').secret;
    const firstCode = exchange.createSecret('10m').secret;
    for (let made = 2; made < 16; made += 1) exchange.createSecret('10m');
    exchange.createSecret('10m');
    expect(await exchange.exchange({ secret: firstCode, label: 'Phone', source: PHONE })).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_USED' });
    expect(await exchange.exchange({ secret: longLink, label: 'Phone', source: PHONE })).toMatchObject({ ok: true });
  });

  it('keeps a waiting link through a Pane restart, and it still works only once', async () => {
    let file: string | null = null;
    let now = Date.parse('2026-11-15T09:00:00Z');
    const start = () => new PairingExchange({ now: () => now, addClient: async () => {}, store: { read: () => file, write: (text) => { file = text; } } });
    const { secret } = start().createSecret('24h');
    expect(file).not.toContain(secret);

    now += 23 * 60 * 60_000;
    const restarted = start();
    await expect(restarted.exchange({ secret, label: 'Studio Mac', source: PHONE })).resolves.toMatchObject({ ok: true });
    await expect(start().exchange({ secret, label: 'Studio Mac', source: PHONE })).resolves.toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_USED' });
  });

  it('records a computer that redeems a secret as a linked computer', async () => {
    const { exchange, saved } = setup();
    const { secret } = exchange.createSecret('1h');
    await exchange.exchange({ secret, label: 'Build Box', computerId: 'buildbox0000000a', source: PHONE });
    expect(saved[0]).toMatchObject({ label: 'Build Box', kind: 'computer', computerId: 'buildbox0000000a' });
  });

  it('keeps a read-only link read-only through a restart, and a Pane from before access levels refuses its secret and token', async () => {
    let text: string | null = null;
    const store = { read: () => text, write: (next: string) => { text = next; } };
    const saved: RemoteDaemonClientRecord[] = [];
    const deps = { store, addClient: async (record: RemoteDaemonClientRecord) => { saved.push(record); } };
    const { secret } = new PairingExchange(deps).createSecret('1h', 'read');
    // What an older Pane compares: the plain hash of the presented secret or token.
    const plain = (value: string) => createHash('sha256').update(value).digest('hex');
    expect(text).not.toContain(plain(secret));

    const result = await new PairingExchange(deps).exchange({ secret, label: 'Parsa', source: PHONE });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(saved).toEqual([expect.objectContaining({ access: 'read' })]);
    for (const sent of [result.token, `read:${result.token}`, createHash('sha256').update(result.token).digest('latin1'), result.token.replace('pane_read_', '')]) expect(saved[0].tokenHash).not.toBe(plain(sent));
    expect(authenticateRemoteDaemonBearerToken(`Bearer ${result.token}`, saved)).toMatchObject({ ok: true, client: { access: 'read' } });
    const { access: _dropped, ...stripped } = saved[0];
    expect(authenticateRemoteDaemonBearerToken(`Bearer ${result.token}`, [stripped])).toMatchObject({ ok: false });
    expect(authenticateRemoteDaemonBearerToken(`Bearer ${result.token.replace('pane_read_', '')}`, saved)).toMatchObject({ ok: false });
  });
});
