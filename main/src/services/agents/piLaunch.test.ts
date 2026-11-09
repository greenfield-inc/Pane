import { describe, expect, it } from 'vitest';
import {
  canAddPiSessionId,
  isValidPiSessionId,
  piCommandSessionId,
  PI_SESSION_ID_PATTERN,
  resolvePiLaunchCommand,
} from './piLaunch';

const ALLOCATED = '0b6a3f0e-8d1c-4f6e-9a57-3d2c1b0a9f8e';
const allocate = () => ALLOCATED;

describe('Pi session ids', () => {
  it.each([
    ALLOCATED,
    'a',
    'my-session_1.2',
    '01a1c24e-73d0-7736-9703-bb8b6ac1bcf0',
  ])('accepts %s', (id) => {
    expect(isValidPiSessionId(id)).toBe(true);
  });

  // Rules from pi 1.5.0's own error: "contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character".
  it.each([
    '',
    '-leading',
    'trailing-',
    '.dot',
    'has space',
    'quote"d',
    'semi;colon',
    'new\nline',
    'trailing-newline\n',
  ])('rejects %j', (id) => {
    expect(isValidPiSessionId(id)).toBe(false);
    expect(PI_SESSION_ID_PATTERN.test(id)).toBe(false);
  });
});

describe('resolvePiLaunchCommand', () => {
  it('allocates a session id for a fresh launch', () => {
    expect(resolvePiLaunchCommand({ baseCommand: 'pi', allocate })).toEqual({
      commandToRun: `pi --session-id ${ALLOCATED}`,
      sessionId: ALLOCATED,
    });
  });

  it('reopens the saved session with the same command', () => {
    const saved = '6f1d2c3a-1111-4222-8333-444455556666';
    expect(resolvePiLaunchCommand({ baseCommand: 'pi --thinking high', persistedSessionId: saved, allocate })).toEqual({
      commandToRun: `pi --thinking high --session-id ${saved}`,
      sessionId: saved,
    });
  });

  it('trims a saved id and replaces one pi would reject', () => {
    expect(resolvePiLaunchCommand({ baseCommand: 'pi', persistedSessionId: ' saved-1\n', allocate }).sessionId).toBe('saved-1');
    expect(resolvePiLaunchCommand({ baseCommand: 'pi', persistedSessionId: 'ses_bad;id', allocate }).sessionId).toBe(ALLOCATED);
  });

  it('refuses an allocated id pi would reject', () => {
    expect(() => resolvePiLaunchCommand({ baseCommand: 'pi', allocate: () => '-bad' })).toThrow(/not valid/);
  });

  it.each([
    'PI_OFFLINE=1 pi',
    'env PI_CODING_AGENT_DIR=/tmp/pi pi --model sonnet',
    '/opt/homebrew/bin/pi',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd',
  ])('adds the id to the direct command %s', (command) => {
    expect(resolvePiLaunchCommand({ baseCommand: command, allocate, platform: 'linux' }).commandToRun).toBe(`${command} --session-id ${ALLOCATED}`);
  });

  it.each([
    'pi --continue',
    'pi -c',
    'pi --resume',
    'pi -r',
    'pi --session ~/.pi/agent/sessions/x.jsonl',
    'pi --fork abc',
    'pi --no-session',
    'pi -- "--do not read as flags"',
    'bash -lc pi',
    'pi && echo done',
    'npx pi',
    'pipx run something',
  ])('runs %s unchanged', (command) => {
    expect(canAddPiSessionId(command, 'linux')).toBe(false);
    expect(resolvePiLaunchCommand({ baseCommand: command, allocate, platform: 'linux' })).toEqual({ commandToRun: command, sessionId: undefined });
  });

  it('records the id a command chooses itself', () => {
    expect(resolvePiLaunchCommand({ baseCommand: 'pi --session-id mine-1', allocate })).toEqual({ commandToRun: 'pi --session-id mine-1', sessionId: 'mine-1' });
    expect(piCommandSessionId('pi --session-id=mine-2')).toBe('mine-2');
    expect(piCommandSessionId('pi -- --session-id mine-3')).toBeUndefined();
  });
});
