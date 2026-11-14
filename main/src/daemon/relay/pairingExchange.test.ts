import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { PairingExchange } from './pairingExchange';
import type { RemoteDaemonClientRecord } from '../../../../shared/types/remoteDaemon';

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
    const result = await exchange.exchange(secret, 'Ana’s iPhone');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(saved).toHaveLength(1);
    expect(saved[0].label).toBe('Ana’s iPhone');
    expect(saved[0].tokenHash).toBe(createHash('sha256').update(result.token).digest('hex'));
    expect(await exchange.exchange(secret, 'Second phone')).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_USED' });
  });

  it('refuses a secret after 10 minutes', async () => {
    const { exchange, advance } = setup();
    const { secret } = exchange.createSecret();
    advance(10 * 60_000 + 1);
    expect(await exchange.exchange(secret, 'Phone')).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_EXPIRED' });
  });

  it('locks the route for 15 minutes after five wrong secrets in a minute', async () => {
    const { exchange, logs, advance } = setup();
    const { secret } = exchange.createSecret();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await exchange.exchange(`wrong-${attempt}`, 'Phone')).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_INVALID' });
    }
    expect(await exchange.exchange(secret, 'Phone')).toMatchObject({ ok: false, code: 'ERR_PAIRING_LOCKED' });
    expect(logs.some((line) => line.includes('locked'))).toBe(true);
    advance(15 * 60_000 + 1);
    expect(await exchange.exchange(secret, 'Phone')).toMatchObject({ ok: false, code: 'ERR_PAIRING_CODE_EXPIRED' });
  });

  it('tells the dialog when its code was used, so it can show a fresh one', async () => {
    const { exchange } = setup();
    const used: string[] = [];
    exchange.onPaired((event) => used.push(event.label));
    const { secret } = exchange.createSecret();
    await exchange.exchange(secret, 'Pixel 9');
    expect(used).toEqual(['Pixel 9']);
  });
});
