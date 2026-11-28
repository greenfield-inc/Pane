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

describe('every shape of reason becomes one plain line (review 1781 round 6)', () => {
  const short = 'Build box answered with an error instead of opening. Try again in a moment.';
  it.each([
    ['Host answered 502: {"error":"bad gateway"}', 'Host answered 502.'],
    ['Request failed\n<!DOCTYPE html>', 'Request failed'],
    ['Error invoking remote method \'remote-daemon:update-client-state\': Error: {"code":"X"}', short],
    ['Error invoking remote method \'x\': PaneError: Build box refused the switch.', 'Build box refused the switch.'],
    ['line one\nline two\n    at Object.<anonymous> (file.js:1:1)', 'line one'],
    ['[object Object]', short],
    ['null', short],
    ['   ', short],
    ['Unexpected server response: 502', 'Unexpected server response: 502'],
  ])('%j', (raw, shown) => {
    expect(switchFailureReason(raw, 'Build box')).toBe(shown);
  });
});

describe('a bracket inside a readable reason is part of it (review 1781 round 7)', () => {
  it.each([
    ['Build box [studio] is offline', 'Build box [studio] is offline'],
    ['Pane on Build box <2.4.200> is too old', 'Pane on Build box <2.4.200> is too old'],
    ['Host answered 502: {"error":"bad gateway"}', 'Host answered 502.'],
    ['Host answered 502: [{"code":1}]', 'Host answered 502.'],
    ['Gateway said <html><body>502</body></html>', 'Gateway said.'],
  ])('%j', (raw, shown) => {
    expect(switchFailureReason(raw, 'Build box')).toBe(shown);
  });
});
