import { describe, expect, it } from 'vitest';
import { switchFailureReason } from './switchErrorText';

describe('a failed switch says why in a short line (QA 1781 note)', () => {
  it('keeps a readable reason as it is', () => {
    expect(switchFailureReason('socket hang up', 'Build box')).toBe('socket hang up');
    expect(switchFailureReason('Build box needs its password. Enter it in Remote Access settings, then try again.', 'Build box')).toBe('Build box needs its password. Enter it in Remote Access settings, then try again.');
  });
  it('replaces an empty body, JSON or an HTML page with a short reason', () => {
    const short = 'Build box answered with an error instead of opening. Try again in a moment.';
    expect(switchFailureReason('{}', 'Build box')).toBe(short);
    expect(switchFailureReason('', 'Build box')).toBe(short);
    expect(switchFailureReason('<html><head><title>503 Service Unavailable</title></head><body>nginx</body></html>', 'Build box')).toBe(short);
    expect(switchFailureReason('Error invoking remote method \'remote-daemon:update-client-state\': {"error":"x"}', 'Build box')).toBe(short);
  });
  it('shortens a very long reason', () => {
    const reason = switchFailureReason(`The host said ${'x'.repeat(400)}`, 'Build box');
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason.endsWith('…')).toBe(true);
  });
});
