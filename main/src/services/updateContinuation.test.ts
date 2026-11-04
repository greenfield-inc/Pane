import { describe, expect, it } from 'vitest';
import type { TerminalPanelState } from '../../../shared/types/panels';
import { checkpointUpdatePanel, updateContinuation } from './updateContinuation';
describe('update continuation eligibility', () => {
  it('requires recorded identity and active work', () => {
    expect(updateContinuation({ agentType: 'codex' }, 'working').eligible).toBe(false);
    expect(updateContinuation({ agentType: 'codex', agentSessionId: 'exact-id' }, 'working').eligible).toBe(true);
    for (const activity of ['idle', 'blocked', 'unknown'] as const) expect(updateContinuation({ agentType: 'codex', agentSessionId: 'exact-id' }, activity).eligible).toBe(false);
  });
  it('does not replay opaque wrappers or completed work', () => {
    expect(updateContinuation({ agentType: 'codex', agentSessionId: 'exact-id', launchMode: 'wrapped' }, 'working').eligible).toBe(false);
    expect(updateContinuation({ agentType: 'codex', agentSessionId: 'exact-id', agentReport: { state: 'done', reportedAt: 'now' } }, 'working').eligible).toBe(false);
  });
  it('preserves an explicit custom resume profile', () => {
    expect(updateContinuation({ agentSessionId: 'exact-id', initialCommand: 'wrapper profile', launchMode: 'wrapped', customResume: { mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} --resume {sessionId}' } }, 'working').eligible).toBe(true);
  });
});

describe('update checkpoint before shutdown', () => {
  it('preserves prior approval, composer, launch profile and cwd independently of shutdown mutation', () => {
    const state: TerminalPanelState = { agentType: 'codex', agentSessionId: 'conversation', cwd: '/repo/panel', orchestrationWorkspace: '/session/owned', orchestrationProfile: 'reviewer', launchCommand: 'codex --model custom', screenText: '› unsent draft', agentReport: { state: 'blocked', question: 'Approve?', reportedAt: 'before' } };
    const checkpoint = checkpointUpdatePanel(state, 'blocked', '/repo/worktree');
    state.wasInterrupted = true;
    state.screenText = '^C';
    state.agentReport!.state = 'done';
    expect(checkpoint).toMatchObject({ activity: 'blocked', cwd: '/session/owned', eligible: false, priorState: { orchestrationProfile: 'reviewer', launchCommand: 'codex --model custom', screenText: '› unsent draft', agentReport: { state: 'blocked', question: 'Approve?' } } });
    expect(checkpoint.priorState).not.toHaveProperty('wasInterrupted');
  });
  it('does not restart work with unsubmitted input and never falls back to the app cwd', () => {
    const pending = checkpointUpdatePanel({ agentType: 'codex', agentSessionId: 'conversation', screenText: '› unsent draft', cwd: '/panel/launch' }, 'working', '/repo/worktree');
    expect(pending).toMatchObject({ eligible: false, requiresAttention: true, cwd: '/panel/launch' });
    expect(checkpointUpdatePanel({ agentType: 'codex', agentSessionId: 'conversation' }, 'working')).toMatchObject({ eligible: false, requiresAttention: true });
    expect(checkpointUpdatePanel({}, 'idle', '/repo/worktree').cwd).toBe('/repo/worktree');
  });
});
