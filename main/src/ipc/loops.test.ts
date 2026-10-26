import { describe, expect, it } from 'vitest';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { StoredLoop } from '../services/loops/loopRepository';
import { prepareLoopSession, startLoopRun } from './loops';

// Slot times are worked for New York: 07:00 UTC on Oct 24 2026 is 03:00 EDT.
process.env.TZ = 'America/New_York';

const slotAtMs = Date.parse('2026-10-24T07:00:00Z');

/** A run context in which Pane launched nothing it remembers. */
const noLaunches = { launchedCommand: () => undefined };

const nightly: StoredLoop = {
  id: 'loop-1',
  name: 'Nightly bug sweep',
  projectId: 1,
  cron: '0 3 * * *',
  agent: 'claude',
  initialInput: 'Sweep yesterday’s merged PRs for bugs.',
  enabled: true,
  scheduleFromMs: 0,
  createdAtMs: 0,
};

/** A registry whose `panes create` answers with `item` and records every call. */
function registryAnswering(item: Record<string, PaneCommandValue>) {
  const calls: Array<{ channel: string; request: PaneCommandValue }> = [];
  const registry = new PaneCommandRegistry();
  registry.register('runpane:panes:create', (request: PaneCommandValue) => {
    calls.push({ channel: 'runpane:panes:create', request });
    return { ok: item.ok, repo: { id: 1 }, items: [item] };
  });
  registry.register('runpane:panes:rename', (request: PaneCommandValue) => {
    calls.push({ channel: 'runpane:panes:rename', request });
    return { ok: true };
  });
  return { registry, calls };
}

describe('startLoopRun', () => {
  it('creates an agent run through panes create, waits for its prompt, and labels it by loop and slot', async () => {
    const { registry, calls } = registryAnswering({ ok: true, index: 0, name: 'x', pinned: false, sessionId: 'pane-7' });

    await expect(startLoopRun(registry, nightly, slotAtMs, noLaunches)).resolves.toEqual({ sessionId: 'pane-7' });
    expect(calls).toEqual([
      {
        channel: 'runpane:panes:create',
        request: {
          repo: { id: 1 },
          noFocus: true,
          waitReady: true,
          panes: [{
            name: 'nightly-bug-sweep · Oct 24 03:00',
            worktreeName: 'loop-nightly-bug-sweep-20261024-0300',
            pinned: false,
            tool: { agent: 'claude', initialInput: 'Sweep yesterday’s merged PRs for bugs.' },
          }],
        },
      },
      { channel: 'runpane:panes:rename', request: { paneId: 'pane-7', name: 'nightly-bug-sweep · Oct 24 03:00' } },
    ]);
  });

  it('runs a command loop with its branch template and no prompt to wait for', async () => {
    const { registry, calls } = registryAnswering({ ok: true, index: 0, name: 'x', pinned: false, sessionId: 'pane-8' });
    const command: StoredLoop = {
      ...nightly,
      agent: undefined,
      initialInput: undefined,
      toolCommand: 'agent-farm run dependency-check',
      worktreeTemplate: 'Deps Check',
    };

    await startLoopRun(registry, command, slotAtMs, noLaunches);
    expect(calls[0].request).toEqual({
      repo: { id: 1 },
      noFocus: true,
      waitReady: false,
      panes: [{
        name: 'nightly-bug-sweep · Oct 24 03:00',
        worktreeName: 'deps-check-20261024-0300',
        pinned: false,
        tool: { command: 'agent-farm run dependency-check' },
      }],
    });
  });

  it('returns a warning when the Pane started but its prompt was not confirmed', async () => {
    const { registry } = registryAnswering({
      ok: false,
      index: 0,
      name: 'x',
      pinned: false,
      sessionId: 'pane-9',
      readiness: { ok: true },
      initialInput: { delivered: true, submitted: false, inputBytes: 40, delivery: { state: 'in-composer', evidence: 'screen', message: 'The prompt is still in the composer.' } },
    });

    await expect(startLoopRun(registry, nightly, slotAtMs, noLaunches)).resolves.toEqual({
      sessionId: 'pane-9',
      warning: 'Pane could not confirm the prompt was submitted. The prompt is still in the composer.',
    });
  });

  it('returns a warning when the agent never became ready', async () => {
    const { registry } = registryAnswering({
      ok: false,
      index: 0,
      name: 'x',
      pinned: false,
      sessionId: 'pane-10',
      readiness: { ok: false, reason: { code: 'agent-not-ready', message: 'Claude did not show its prompt within 60s.' } },
      // Claude takes its prompt on the command line, so delivery has evidence but no message.
      initialInput: { delivered: false, submitted: false, inputBytes: 40, delivery: { state: 'unknown', evidence: 'argv' } },
    });

    await expect(startLoopRun(registry, nightly, slotAtMs, noLaunches)).resolves.toEqual({
      sessionId: 'pane-10',
      warning: 'When the run started, the agent did not become ready, so Pane could not confirm it got its prompt. Claude did not show its prompt within 60s.',
    });
  });

  it('says how to clear a folder-trust prompt the run is stuck at', async () => {
    const { registry } = registryAnswering({
      ok: false,
      index: 0,
      name: 'x',
      pinned: false,
      sessionId: 'pane-11',
      readiness: {
        ok: false,
        blocked: {
          kind: 'first-run-dialog',
          message: ' Accessing workspace:\n\n /repos/demo/worktrees/loop-ping-20261025-0118\n\n Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel',
          suggestedCommand: 'runpane panels input --panel p --keys down,enter --yes --json',
        },
      },
      initialInput: { delivered: false, submitted: false, inputBytes: 40, delivery: { state: 'unknown', evidence: 'argv' } },
    });

    await expect(startLoopRun(registry, nightly, slotAtMs, noLaunches)).resolves.toEqual({
      sessionId: 'pane-11',
      warning: 'When it started, the run was stopped at the agent\'s folder-trust prompt in its new worktree. '
        + 'If it is still there, open the run and answer it, or trust the project folder in the agent once so later runs start on their own.',
    });
  });

  it('fails the run when no Pane was created', async () => {
    const { registry } = registryAnswering({ ok: false, index: 0, error: { code: 'ERR_GIT', message: 'The default branch could not be fetched.' } });

    await expect(startLoopRun(registry, nightly, slotAtMs, noLaunches)).rejects.toThrow('The default branch could not be fetched.');
  });
});

const SESSION_ID = '__orchestration_session_1111__';
const panelIds = { claude: 'claude-panel', codex: 'codex-panel', cursor: 'cursor-panel' };

/** A registry with stub Session and panel commands; records every call. */
function sessionRegistry(options: {
  session?: Record<string, PaneCommandValue>;
  resume?: Record<string, PaneCommandValue>;
  submit?: Record<string, PaneCommandValue>;
} = {}) {
  const calls: Array<{ channel: string; request: PaneCommandValue }> = [];
  const registry = new PaneCommandRegistry();
  const session = { id: SESSION_ID, name: 'Standups', agent: 'claude', launchCommand: '', panelIds, ...options.session };
  const answer = (channel: string, result: PaneCommandValue) => registry.register(channel, (request: PaneCommandValue) => {
    calls.push({ channel, request });
    return result;
  });
  answer('runpane:sessions:get', { ok: true, session });
  answer('runpane:sessions:create', { ok: true, session: { ...session, name: 'Morning standup' } });
  answer('runpane:sessions:update', { ok: true, session });
  answer('runpane:panels:resume', { ok: true, readiness: { ok: true, state: { running: true, agentType: session.agent } }, ...options.resume });
  answer('runpane:panels:submit', { ok: true, ...options.submit });
  return { registry, calls };
}

describe('startLoopRun for a Session loop', () => {
  const standup: StoredLoop = { ...nightly, projectId: undefined, orchestrationSessionId: SESSION_ID, initialInput: 'Post the standup.' };

  it('starts the Session agent tab and sends the prompt there, with no new Pane', async () => {
    const { registry, calls } = sessionRegistry();
    await expect(startLoopRun(registry, standup, slotAtMs, noLaunches)).resolves.toEqual({ sessionId: null });
    expect(calls).toEqual([
      { channel: 'runpane:sessions:get', request: { sessionId: SESSION_ID } },
      { channel: 'runpane:panels:resume', request: { panelId: 'claude-panel', waitReady: true } },
      { channel: 'runpane:panels:submit', request: { panelId: 'claude-panel', input: 'Post the standup.', source: 'agent', expectReport: false } },
    ]);
  });

  it('does not type the prompt into a prompt the agent is stopped at', async () => {
    const { registry, calls } = sessionRegistry({ resume: { readiness: { ok: false, blocked: { message: 'Do you want to proceed? 1. Yes 2. No' }, state: { running: true, agentType: 'claude' } } } });
    await expect(startLoopRun(registry, standup, slotAtMs, noLaunches)).resolves.toEqual({
      sessionId: null,
      warning: 'When this run started, the Session\'s agent was stopped at a prompt. The loop\'s prompt was not sent. Open the Session and answer it.',
    });
    expect(calls.map(call => call.channel)).not.toContain('runpane:panels:submit');
  });

  it('never types the prompt into a shell whose agent launch exited or never showed an agent', async () => {
    // The reviewer's repro: the custom command exits back to a live shell, and resume reports command-exited.
    const exited = sessionRegistry({ resume: { readiness: {
      ok: false,
      reason: { code: 'command-exited', message: 'The Claude Code command exited back to the shell, so the panel will not become ready. It printed: "error: unknown option \'--bogus-flag\'". Nothing was sent to it.' },
      state: { running: true },
    } } });
    await expect(startLoopRun(exited.registry, standup, slotAtMs, noLaunches)).resolves.toEqual({
      sessionId: null,
      warning: 'When this run started, the Session\'s agent was not running: its launch command exited back to the shell, printing "error: unknown option \'--bogus-flag\'". '
        + 'The loop\'s prompt was not sent. Open the Session, fix the agent\'s launch command, and start the agent again in its tab; the next run sends the prompt.',
    });
    expect(exited.calls.map(call => call.channel)).not.toContain('runpane:panels:submit');

    const noAgent = sessionRegistry({ resume: { readiness: { ok: false, reason: { code: 'no-agent-detected', message: 'No agent.' }, state: { running: true } } } });
    await startLoopRun(noAgent.registry, standup, slotAtMs, noLaunches);
    const stopped = sessionRegistry({ resume: { readiness: { ok: false, state: { running: false } } } });
    await startLoopRun(stopped.registry, standup, slotAtMs, noLaunches);
    // Windows QA: the launch failed and left a bare shell that Pane cannot tell has exited, so the declared agent is never ready and is not working.
    const bareShell = sessionRegistry({ resume: { readiness: {
      ok: false,
      reason: { code: 'agent-not-ready', message: 'Pane detected Claude Code, but its input box was not ready within 60 s.' },
      state: { running: true, agentType: 'claude', activityStatus: 'idle' },
    } } });
    await expect(startLoopRun(bareShell.registry, standup, slotAtMs, noLaunches)).resolves.toEqual({
      sessionId: null,
      warning: 'When this run started, no ready agent was found in the Session\'s tab; its launch may have failed and left a plain shell. '
        + 'The loop\'s prompt was not sent. Open the Session and start the agent again in its tab; the next run sends the prompt.',
    });
    expect([...noAgent.calls, ...stopped.calls, ...bareShell.calls].map(call => call.channel)).not.toContain('runpane:panels:submit');
  });

  it('queues the prompt for an agent that is busy on a turn', async () => {
    const { registry, calls } = sessionRegistry({ resume: { readiness: {
      ok: false,
      reason: { code: 'agent-not-ready', message: 'Pane detected Claude Code, but its input box was not ready within 60 s.' },
      state: { running: true, agentType: 'claude', activityStatus: 'active' },
    } } });
    await expect(startLoopRun(registry, standup, slotAtMs, noLaunches)).resolves.toEqual({ sessionId: null });
    expect(calls.map(call => call.channel)).toContain('runpane:panels:submit');
  });

  it('holds runs while the agent still runs from a launch without the unattended flags', async () => {
    const stale = sessionRegistry();
    await expect(startLoopRun(stale.registry, standup, slotAtMs, { launchedCommand: () => 'claude --append-system-prompt "Never use --dangerously-skip-permissions"' })).resolves.toEqual({
      sessionId: null,
      warning: 'When this run started, the Session\'s agent was still running from before it was set to skip permission prompts. The loop\'s prompt was not sent. '
        + 'Exit the agent in the Session\'s tab and start it again (it resumes the same conversation); the next run sends the prompt.',
    });
    expect(stale.calls.map(call => call.channel)).not.toContain('runpane:panels:submit');

    const restarted = sessionRegistry();
    await expect(startLoopRun(restarted.registry, standup, slotAtMs, { launchedCommand: () => 'claude --dangerously-skip-permissions --resume 5f0c' })).resolves.toEqual({ sessionId: null });
  });

  it('warns when the prompt was not confirmed, and fails when the Session is archived', async () => {
    const unconfirmed = sessionRegistry({ submit: { ok: false, blocked: { message: 'The agent is waiting for input.' } } });
    await expect(startLoopRun(unconfirmed.registry, standup, slotAtMs, noLaunches)).resolves.toEqual({
      sessionId: null,
      // App words only: no CLI commands from the submit result.
      warning: 'When this run started, Pane could not confirm the Session\'s agent got the prompt. Open the Session to check whether it arrived.',
    });
    const archived = sessionRegistry({ session: { archived: true } });
    await expect(startLoopRun(archived.registry, standup, slotAtMs, noLaunches)).rejects.toThrow('Session Standups is archived, so the prompt was not sent.');
  });
});

describe('prepareLoopSession', () => {
  const noTrust = async () => undefined;

  it('marks the Session folder trusted for a Claude loop only, after the Session is set up', async () => {
    const trusted: string[] = [];
    const trust = async (sessionId: string) => { trusted.push(sessionId); };
    await prepareLoopSession(sessionRegistry().registry, 'new', { name: 'Morning standup', agent: 'claude' }, trust);
    await prepareLoopSession(sessionRegistry({ session: { agent: 'codex' } }).registry, SESSION_ID, { name: 'Standup', agent: 'codex' }, trust);
    expect(trusted).toEqual([SESSION_ID]);
    // A refused save trusts nothing.
    const wrapped = sessionRegistry({ session: { launchCommand: "sh -c 'claude'" } });
    await expect(prepareLoopSession(wrapped.registry, SESSION_ID, { name: 'Standup', agent: 'claude' }, trust)).rejects.toMatchObject({ code: 'ERR_LOOP_INVALID' });
    expect(trusted).toEqual([SESSION_ID]);
  });

  it('creates a new Session named after the loop, already unattended by its default command', async () => {
    const { registry, calls } = sessionRegistry();
    await expect(prepareLoopSession(registry, 'new', { name: 'Morning standup', agent: 'claude' }, noTrust)).resolves.toBe(SESSION_ID);
    expect(calls).toEqual([{ channel: 'runpane:sessions:create', request: { name: 'Morning standup', agent: 'claude', launchCommand: '' } }]);
  });

  it('finds a Session by name and adds the missing unattended flag to its custom command', async () => {
    const { registry, calls } = sessionRegistry({ session: { agent: 'codex', launchCommand: 'codex --model gpt-5' } });
    await expect(prepareLoopSession(registry, 'Standups', { name: 'Standup', agent: 'codex' }, noTrust)).resolves.toBe(SESSION_ID);
    expect(calls).toEqual([
      { channel: 'runpane:sessions:get', request: { name: 'Standups' } },
      { channel: 'runpane:sessions:update', request: { selector: { sessionId: SESSION_ID }, input: { launchCommand: 'codex --yolo --model gpt-5', source: 'user' } } },
    ]);
  });

  it('adds the flag to the agent itself, not because a quoted argument mentions it', async () => {
    const { registry, calls } = sessionRegistry({ session: { launchCommand: 'claude --append-system-prompt "Never use --dangerously-skip-permissions on production"' } });
    await prepareLoopSession(registry, SESSION_ID, { name: 'Standup', agent: 'claude' }, noTrust);
    expect(calls[1]).toEqual({ channel: 'runpane:sessions:update', request: { selector: { sessionId: SESSION_ID }, input: {
      launchCommand: 'claude --dangerously-skip-permissions --append-system-prompt "Never use --dangerously-skip-permissions on production"', source: 'user',
    } } });
  });

  it('refuses a wrapped or compound launch command it cannot change safely, and changes nothing', async () => {
    for (const launchCommand of ["sh -c 'codex --model gpt-5'", 'codex --model gpt-5 && say done', 'OPENAI_API_KEY=x codex', 'npx codex']) {
      const { registry, calls } = sessionRegistry({ session: { agent: 'codex', launchCommand } });
      await expect(prepareLoopSession(registry, SESSION_ID, { name: 'Standup', agent: 'codex' }, noTrust)).rejects.toMatchObject({
        code: 'ERR_LOOP_INVALID',
        message: `Session Standups launches its agent with \`${launchCommand}\`, which Pane cannot safely change to skip permission prompts. Nothing was saved.`,
      });
      expect(calls.map(call => call.channel)).toEqual(['runpane:sessions:get']);
    }
  });

  it('leaves a command that already skips prompts alone, and switches a Session to the loop\'s agent', async () => {
    const unattended = sessionRegistry({ session: { agent: 'cursor', launchCommand: 'cursor-agent --trust --force' } });
    await prepareLoopSession(unattended.registry, SESSION_ID, { name: 'Standup', agent: 'cursor' }, noTrust);
    expect(unattended.calls.map(call => call.channel)).toEqual(['runpane:sessions:get']);

    const other = sessionRegistry({ session: { agent: 'codex', launchCommand: 'codex' } });
    await prepareLoopSession(other.registry, SESSION_ID, { name: 'Standup', agent: 'claude' }, noTrust);
    expect(other.calls[1]).toEqual({ channel: 'runpane:sessions:update', request: { selector: { sessionId: SESSION_ID }, input: { agent: 'claude', source: 'user' } } });
  });
});
