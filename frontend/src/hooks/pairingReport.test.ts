import { describe, expect, it } from 'vitest';
import { PairingReport } from './pairingReport';
import type { PairingView } from './useRelayPairing';

function opening(views: PairingView[], closed = true): Array<[string, object]> {
  const sent: Array<[string, object]> = [];
  const report = new PairingReport((event, properties) => { sent.push([event, properties]); });
  for (const view of views) report.observe(view);
  if (closed) report.close();
  return sent;
}

const preparing: PairingView = { step: 'preparing', label: 'Connecting to Pane…' };
const code: PairingView = { step: 'code', url: 'https://runpane.net/pair#s=x', secondsLeft: 600 };

describe('what one opening of Add a device › Phone reports', () => {
  it('reports the code shown once, however often the countdown ticks', () => {
    expect(opening([preparing, code, { ...code, secondsLeft: 599 }])).toEqual([['pairing_opened', { qr: 'shown' }]]);
  });

  it('reports a code that ran out unused as a timeout, once', () => {
    expect(opening([code, { step: 'renewing' }, code, { step: 'renewing' }])).toEqual([
      ['pairing_opened', { qr: 'shown' }],
      ['pairing_failed', { reason: 'timeout' }],
    ]);
  });

  it('reports the certificate limit as paused and failed', () => {
    expect(opening([preparing, { step: 'limited', until: '2026-11-22T00:00:00Z' }])).toEqual([
      ['pairing_opened', { qr: 'paused', paused_reason: 'certificate_limit' }],
      ['pairing_failed', { reason: 'certificate_limit' }],
    ]);
  });

  it('tells a relay that did not answer from a code that could not be made', () => {
    expect(opening([{ step: 'error', message: "Pane's servers didn't answer.", cause: 'relay' }])).toContainEqual(['pairing_failed', { reason: 'relay_unreachable' }]);
    expect(opening([{ step: 'error', message: "Pane couldn't make a pairing code.", cause: 'code' }])).toContainEqual(['pairing_failed', { reason: 'other' }]);
  });

  it('reports an opening closed while still getting ready as paused, not ready', () => {
    expect(opening([preparing])).toEqual([['pairing_opened', { qr: 'paused', paused_reason: 'not_ready' }]]);
  });

  it('reports nothing for an opening that never showed the Phone tab', () => {
    expect(opening([])).toEqual([]);
  });
});
