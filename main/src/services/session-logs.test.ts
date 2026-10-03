import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addSessionLog, cleanupSessionLogs, clearSessionLogs, startSessionLogs, getSessionLogs } from './session-logs';

beforeEach(() => {
  startSessionLogs('logs-test');
  startSessionLogs('other-test');
});

afterEach(() => {
  cleanupSessionLogs('logs-test');
  cleanupSessionLogs('other-test');
});

describe('session log retention', () => {
  it('keeps the newest 1,000 entries in arrival order', () => {
    for (let index = 0; index < 1002; index++) addSessionLog('logs-test', 'info', `line ${index}`);
    const logs = getSessionLogs('logs-test');
    expect(logs).toHaveLength(1000);
    expect(logs[0].message).toBe('line 2');
    expect(logs[999].message).toBe('line 1001');
  });

  it('evicts older chunks to stay within 1 MiB of UTF-8 text', () => {
    addSessionLog('logs-test', 'info', 'old');
    addSessionLog('logs-test', 'error', 'é'.repeat(524288));
    expect(getSessionLogs('logs-test')).toHaveLength(1);
    expect(getSessionLogs('logs-test')[0].message).toBe('é'.repeat(524288));
  });

  it('bounds a giant chunk and source without breaking Unicode', () => {
    addSessionLog('logs-test', 'info', '💡'.repeat(400000), 'script');
    const entry = getSessionLogs('logs-test')[0];
    expect(Buffer.byteLength(entry.message) + Buffer.byteLength(entry.source ?? '')).toBeLessThanOrEqual(1048576);
    expect(entry.message).not.toContain('\ufffd');
    expect(entry.message).toMatch(/^(💡)+$/u);
    addSessionLog('other-test', 'info', 'small message', 's'.repeat(2000000));
    expect(getSessionLogs('other-test')[0].source).toHaveLength(1024);
  });

  it('clears only the selected session and permits fresh output', () => {
    addSessionLog('logs-test', 'info', 'old');
    addSessionLog('other-test', 'info', 'keep');
    clearSessionLogs('logs-test');
    expect(getSessionLogs('logs-test')).toEqual([]);
    expect(getSessionLogs('other-test')[0].message).toBe('keep');
    addSessionLog('logs-test', 'warn', 'new');
    expect(getSessionLogs('logs-test').map(entry => entry.message)).toEqual(['new']);
  });
});
