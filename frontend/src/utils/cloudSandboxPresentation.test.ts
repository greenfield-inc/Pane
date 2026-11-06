import { describe, expect, it } from 'vitest';
import type { CloudSandboxView } from '../../../shared/types/cloudSandboxes';
import {
  formatCloudUptime,
  getCloudHostSwitcherEntry,
  getCloudSandboxActions,
  getCloudSandboxBadge,
  getCloudGitHubNotice,
  getCloudLocalStartNotice,
  getCloudSandboxRows,
  getCloudStartupScriptNotice,
  getCloudStepLabel,
  STARTUP_SCRIPT_WARNING,
} from './cloudSandboxPresentation';

function sandbox(overrides: Partial<CloudSandboxView> = {}): CloudSandboxView {
  return {
    id: 'rp-alpha',
    label: 'alpha',
    hostname: 'rp-alpha',
    profileId: 'profile-alpha',
    state: 'running',
    size: 'default',
    ...overrides,
  };
}

describe('getCloudSandboxBadge', () => {
  it('names the provider state, or the action in flight', () => {
    expect(getCloudSandboxBadge(sandbox())).toEqual({ label: 'Running', variant: 'success' });
    expect(getCloudSandboxBadge(sandbox({ state: 'stopped' }))).toEqual({ label: 'Stopped', variant: 'default' });
    expect(getCloudSandboxBadge(sandbox({ state: 'creating' }))).toEqual({ label: 'Creating', variant: 'info' });
    expect(getCloudSandboxBadge(sandbox({ state: 'error' }))).toEqual({ label: 'Error', variant: 'error' });
    expect(getCloudSandboxBadge(sandbox({ state: 'stopped', pending: 'starting' }))).toEqual({ label: 'Starting', variant: 'info' });
    expect(getCloudSandboxBadge(sandbox({ state: 'stopping' }))).toEqual({ label: 'Stopping', variant: 'info' });
  });
});

describe('getCloudStepLabel', () => {
  it('describes known steps and passes unknown ones through', () => {
    expect(getCloudStepLabel('tailnet')).toBe('Joining your tailnet');
    expect(getCloudStepLabel('future-step')).toBe('future-step');
  });
});

describe('formatCloudUptime', () => {
  const now = Date.parse('2026-10-01T12:00:00.000Z');

  it('rounds to minutes, hours, then days', () => {
    expect(formatCloudUptime('2026-10-01T11:59:50.000Z', now)).toBe('running for 1m');
    expect(formatCloudUptime('2026-10-01T11:15:00.000Z', now)).toBe('running for 45m');
    expect(formatCloudUptime('2026-10-01T07:00:00.000Z', now)).toBe('running for 5h');
    expect(formatCloudUptime('2026-09-28T12:00:00.000Z', now)).toBe('running for 3d');
  });

  it('shows nothing for a missing or invalid start time', () => {
    expect(formatCloudUptime(undefined, now)).toBeNull();
    expect(formatCloudUptime('yesterday', now)).toBeNull();
  });

  it('counts a start after the last clock tick as just started', () => {
    expect(formatCloudUptime('2026-10-01T12:00:30.000Z', now)).toBe('running for 1m');
  });
});

describe('getCloudSandboxActions', () => {
  it('offers Open terminal, Stop, Startup script and Remove while running, and Update Pane first when versions differ', () => {
    expect(getCloudSandboxActions(sandbox())).toEqual(['terminal', 'stop', 'startup-script', 'remove']);
    expect(getCloudSandboxActions(sandbox({ updateAvailable: true }))).toEqual(['update', 'terminal', 'stop', 'startup-script', 'remove']);
  });

  it('offers Open terminal only while running', () => {
    for (const state of ['stopped', 'starting', 'stopping', 'creating', 'error'] as const) {
      expect(getCloudSandboxActions(sandbox({ state }))).not.toContain('terminal');
    }
    expect(getCloudSandboxActions(sandbox({ pending: 'stopping' }))).not.toContain('terminal');
    expect(getCloudSandboxActions(sandbox({ state: 'stopped', pending: 'starting' }))).not.toContain('terminal');
    expect(getCloudSandboxActions(sandbox({ stateUnknown: true }))).not.toContain('terminal');
    expect(getCloudSandboxActions(sandbox({ profileId: undefined }))).not.toContain('terminal');
  });

  it('offers Start and Remove while stopped', () => {
    expect(getCloudSandboxActions(sandbox({ state: 'stopped' }))).toEqual(['start', 'startup-script', 'remove']);
  });

  it('offers nothing while work is in flight', () => {
    expect(getCloudSandboxActions(sandbox({ pending: 'stopping' }))).toEqual([]);
    expect(getCloudSandboxActions(sandbox({ state: 'starting' }))).toEqual([]);
    expect(getCloudSandboxActions(sandbox({ id: 'create:alpha', hostname: undefined, state: 'creating' }))).toEqual([]);
  });

  it('offers Retry and Dismiss after a failure, and only those for a failed create', () => {
    expect(getCloudSandboxActions(sandbox({ id: 'create:alpha', hostname: undefined, state: 'error', failedAction: 'create', error: 'quota' })))
      .toEqual(['retry', 'dismiss']);
    expect(getCloudSandboxActions(sandbox({ state: 'stopped', failedAction: 'start', error: 'timeout' })))
      .toEqual(['retry', 'dismiss', 'start', 'startup-script', 'remove']);
  });

  it('still lets an errored sandbox be removed', () => {
    expect(getCloudSandboxActions(sandbox({ state: 'error', error: 'provider says error' }))).toEqual(['remove']);
  });
});

describe('a sandbox the provider is still stopping (D4)', () => {
  const stopping = sandbox({ state: 'stopping', progress: undefined });

  it('shows Stopping on the row with neither Stop nor Start', () => {
    expect(getCloudSandboxBadge(stopping)).toEqual({ label: 'Stopping', variant: 'info' });
    expect(getCloudSandboxActions(stopping)).toEqual([]);
  });

  it('shows Stopping in the switcher with no Start', () => {
    expect(getCloudHostSwitcherEntry(stopping)).toEqual({ description: 'Stopping cloud sandbox…', action: 'wait' });
  });

  it('offers Start on the row and in the switcher once the provider says stopped', () => {
    const stopped = sandbox({ state: 'stopped' });
    expect(getCloudSandboxBadge(stopped).label).toBe('Stopped');
    expect(getCloudSandboxActions(stopped)).toContain('start');
    expect(getCloudHostSwitcherEntry(stopped)).toEqual({ description: 'Stopped · Select to start', action: 'start' });
  });

  it('shows an unreadable state as Checking, with no actions on the row or in the switcher', () => {
    const unknown = sandbox({ state: 'running', stateUnknown: true, failedAction: 'stop', error: 'did not reach stopped' });
    expect(getCloudSandboxBadge(unknown)).toEqual({ label: 'Checking', variant: 'default' });
    expect(getCloudSandboxActions(unknown)).toEqual([]);
    expect(getCloudHostSwitcherEntry(unknown)).toEqual({ description: 'Checking cloud sandbox…', action: 'wait' });
  });

  it('shows a failed action on a running sandbox as Running with the error', () => {
    const failed = sandbox({ state: 'running', failedAction: 'stop', error: 'boat refused the stop' });
    expect(getCloudSandboxBadge(failed).label).toBe('Running');
    expect(getCloudSandboxActions(failed)).toEqual(['retry', 'dismiss', 'terminal', 'stop', 'startup-script', 'remove']);
  });
});

describe('getCloudHostSwitcherEntry', () => {
  it('keeps the normal row for ordinary hosts and running sandboxes', () => {
    expect(getCloudHostSwitcherEntry(undefined)).toBeNull();
    expect(getCloudHostSwitcherEntry(sandbox())).toBeNull();
  });

  it('turns a stopped sandbox into a Start action', () => {
    expect(getCloudHostSwitcherEntry(sandbox({ state: 'stopped' }))).toEqual({
      description: 'Stopped · Select to start',
      action: 'start',
    });
  });

  it('waits while the sandbox starts and offers a retry when the start failed', () => {
    expect(getCloudHostSwitcherEntry(sandbox({ state: 'stopped', pending: 'starting' }))?.action).toBe('wait');
    expect(getCloudHostSwitcherEntry(sandbox({ state: 'starting' }))?.action).toBe('wait');
    expect(getCloudHostSwitcherEntry(sandbox({ state: 'stopped', failedAction: 'start', error: 'resume timed out' }))).toEqual({
      description: 'Start failed: resume timed out · Select to retry',
      action: 'start',
    });
  });
});

describe('getCloudStartupScriptNotice', () => {
  it.each([
    ['no run', undefined, null],
    ['running', { state: 'running' }, { kind: 'running', text: 'Running your startup script…', viewLog: false }],
    ['exit 0', { state: 'succeeded', exitCode: 0 }, null],
    ['exit 1', { state: 'failed', exitCode: 1 }, { kind: 'failed', text: '⚠ Startup script failed (exit 1)', viewLog: true }],
    ['exit 127', { state: 'failed', exitCode: 127 }, { kind: 'failed', text: '⚠ Startup script failed (exit 127)', viewLog: true }],
    ['timed out', { state: 'failed', exitCode: 124, timedOut: true }, { kind: 'failed', text: '⚠ Startup script failed (timed out after 10 min)', viewLog: true }],
    ['could not run', { state: 'error', error: 'boat did not answer' }, { kind: 'failed', text: '⚠ Startup script could not run: boat did not answer', viewLog: false }],
  ] as const)('%s', (_name, startupScript, notice) => {
    expect(getCloudStartupScriptNotice(sandbox({ startupScript }))).toEqual(notice);
  });

  it('warns, word for word, that the script is stored unencrypted', () => {
    expect(STARTUP_SCRIPT_WARNING).toBe("Don't put secrets here; it's stored unencrypted.");
  });

  it('labels the create step that runs the script', () => {
    expect(getCloudStepLabel('startup')).toBe('Running your startup script…');
  });
});

describe('getCloudGitHubNotice', () => {
  it.each([
    ['no token', undefined, null],
    ['signed in', { state: 'signed-in', user: 'octo-cat' }, { kind: 'ok', text: 'GitHub: signed in as octo-cat' }],
    ['signed in, account name unknown', { state: 'signed-in', user: '' }, { kind: 'ok', text: 'GitHub: signed in' }],
    ['invalid', { state: 'invalid' }, { kind: 'warning', text: '⚠ GitHub token invalid' }],
    ['could not apply', { state: 'error', message: "gh isn't installed on the sandbox." },
      { kind: 'warning', text: "⚠ GitHub sign-in didn't finish: gh isn't installed on the sandbox." }],
  ] as const)('%s', (_name, github, notice) => {
    expect(getCloudGitHubNotice(sandbox({ github }))).toEqual(notice);
  });
});

describe('getCloudSandboxRows', () => {
  it('shows a sandbox being created once, as its create', () => {
    const creating = sandbox({ id: 'create:alpha', hostname: undefined, profileId: undefined, state: 'creating' });
    const listed = sandbox();
    const other = sandbox({ id: 'rp-beta', label: 'beta', hostname: 'rp-beta' });
    expect(getCloudSandboxRows([creating, listed, other]).map((row) => row.id)).toEqual(['create:alpha', 'rp-beta']);
    expect(getCloudSandboxRows([listed, other]).map((row) => row.id)).toEqual(['rp-alpha', 'rp-beta']);
    // A failed create's row is not a create in progress.
    const failed = sandbox({ id: 'create:alpha', hostname: undefined, state: 'error', failedAction: 'create' });
    expect(getCloudSandboxRows([failed, listed]).map((row) => row.id)).toEqual(['create:alpha', 'rp-alpha']);
  });
});

describe('getCloudLocalStartNotice', () => {
  it.each<[string, CloudSandboxView['localStart'], ReturnType<typeof getCloudLocalStartNotice>]>([
    ['ran fine or none', undefined, null],
    ['non-zero exit', { state: 'failed', exitCode: 2 }, { kind: 'warning', text: '⚠ Local start script failed (exit 2)' }],
    ['timed out', { state: 'timeout', seconds: 60 }, { kind: 'warning', text: '⚠ Local start script timed out after 60 s' }],
    ["couldn't run", { state: 'error', message: "Couldn't start PowerShell for the local start script." },
      { kind: 'warning', text: "⚠ Local start script didn't run: Couldn't start PowerShell for the local start script." }],
    ['reserved names dropped', { state: 'ok', reserved: ['HOME', 'PATH'] },
      { kind: 'info', text: 'Local start script: skipped reserved names HOME, PATH' }],
  ])('%s', (_name, localStart, notice) => {
    expect(getCloudLocalStartNotice(sandbox({ localStart }))).toEqual(notice);
  });
});
