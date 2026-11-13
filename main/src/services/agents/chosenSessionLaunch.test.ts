import { describe, expect, it } from 'vitest';
import { isAgentSessionId } from '../../../../shared/agents';
import { resolveChosenSessionLaunch, takesChosenSession } from './chosenSessionLaunch';

const ALLOCATED = '0b6a3f0e-8d1c-4f6e-9a57-3d2c1b0a9f8e';
const allocate = () => ALLOCATED;
const launch = (baseCommand: string, persistedSessionId?: string) =>
  resolveChosenSessionLaunch({ agent: 'pi', baseCommand, persistedSessionId, allocate, platform: 'linux' });

describe('Pi session ids', () => {
  it.each([ALLOCATED, 'a', 'my-session_1.2', '01a1c24e-73d0-7736-9703-bb8b6ac1bcf0'])('accepts %s', (id) => {
    expect(isAgentSessionId('pi', id)).toBe(true);
  });

  // Rules from pi 1.5.0's own error: "contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character".
  it.each(['', '-leading', 'trailing-', '.dot', 'has space', 'quote"d', 'semi;colon', 'new\nline', 'trailing-newline\n'])('rejects %j', (id) => {
    expect(isAgentSessionId('pi', id)).toBe(false);
  });
});

describe('resolveChosenSessionLaunch for pi', () => {
  it('allocates a session id for a fresh launch', () => {
    expect(launch('pi')).toEqual({ commandToRun: `pi --session-id ${ALLOCATED}`, sessionId: ALLOCATED });
  });

  it('reopens the saved session with the same command', () => {
    const saved = '6f1d2c3a-1111-4222-8333-444455556666';
    expect(launch('pi --thinking high', saved)).toEqual({ commandToRun: `pi --thinking high --session-id ${saved}`, sessionId: saved });
  });

  it('trims a saved id and replaces one pi would reject', () => {
    expect(launch('pi', ' saved-1\n')?.sessionId).toBe('saved-1');
    expect(launch('pi', 'ses_bad;id')?.sessionId).toBe(ALLOCATED);
  });

  it('refuses an allocated id pi would reject', () => {
    expect(() => resolveChosenSessionLaunch({ agent: 'pi', baseCommand: 'pi', allocate: () => '-bad' })).toThrow(/was not launched/);
  });

  it.each([
    'PI_OFFLINE=1 pi',
    'env PI_CODING_AGENT_DIR=/tmp/pi pi --model sonnet',
    '/opt/homebrew/bin/pi',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\pi.cmd',
  ])('adds the id to the direct command %s', (command) => {
    expect(launch(command)?.commandToRun).toBe(`${command} --session-id ${ALLOCATED}`);
    expect(takesChosenSession(command, 'pi', 'linux')).toBe(true);
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
    'pi auth login anthropic',
    'pi update',
    'pi # my notes',
    'bash -lc pi',
    'pi && echo done',
    'npx pi',
    'pipx run something',
  ])('runs %s unchanged', (command) => {
    expect(launch(command)).toEqual({ commandToRun: command, sessionId: undefined });
    expect(takesChosenSession(command, 'pi', 'linux')).toBe(false);
  });

  it('records the id a command chooses itself', () => {
    expect(launch('pi --session-id mine-1')).toEqual({ commandToRun: 'pi --session-id mine-1', sessionId: 'mine-1' });
    expect(launch('pi --session-id=mine-2')?.sessionId).toBe('mine-2');
    expect(launch('pi -- --session-id mine-3')?.sessionId).toBeUndefined();
  });

  it('leaves agents without a Pane-chosen session to their own launch', () => {
    expect(resolveChosenSessionLaunch({ agent: 'opencode', baseCommand: 'opencode', allocate })).toBeUndefined();
  });
});
