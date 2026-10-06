import { describe, expect, it } from 'vitest';
import { resolveResumeId } from './agentResume';

const PANEL_ID = '11111111-1111-4111-8111-111111111111';
const CAPTURED_ID = '7403f755-6758-40d3-bb69-2cd356dd9bf0';
const OPENCODE_SESSION_ID = 'ses_123ABCxyz';

describe('resolveResumeId', () => {
  it('prefers the saved Claude ID and retains the legacy panel ID fallback', () => {
    expect(resolveResumeId('claude', PANEL_ID, {})).toBe(PANEL_ID);
    expect(resolveResumeId('claude', PANEL_ID, { agentSessionId: CAPTURED_ID })).toBe(CAPTURED_ID);
  });

  it('resumes Codex by captured session id, falling back to the interactive picker', () => {
    expect(resolveResumeId('codex', PANEL_ID, { agentSessionId: CAPTURED_ID })).toBe(CAPTURED_ID);
    expect(resolveResumeId('codex', PANEL_ID, {})).toBe('interactive');
  });

  it('resumes Cursor by captured chat id, falling back to the latest chat', () => {
    expect(resolveResumeId('cursor', PANEL_ID, { agentSessionId: CAPTURED_ID })).toBe(CAPTURED_ID);
    expect(resolveResumeId('cursor', PANEL_ID, {})).toBe('latest');
  });

  it('resumes OpenCode only with a valid captured session id', () => {
    expect(resolveResumeId('opencode', PANEL_ID, { agentSessionId: OPENCODE_SESSION_ID })).toBe(OPENCODE_SESSION_ID);
    expect(resolveResumeId('opencode', PANEL_ID, {})).toBeUndefined();
    expect(resolveResumeId('opencode', PANEL_ID, { agentSessionId: 'malformed' })).toBeUndefined();
    expect(resolveResumeId('opencode', PANEL_ID, { agentSessionId: 'latest' })).toBeUndefined();
    expect(resolveResumeId('opencode', PANEL_ID, { agentSessionId: 'interactive' })).toBeUndefined();
    expect(resolveResumeId('opencode', PANEL_ID, { agentSessionId: PANEL_ID })).toBeUndefined();
  });

  it('resumes custom CLIs only with a recorded ID', () => {
    const customResume = { mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} --resume {sessionId}' } as const;
    expect(resolveResumeId(undefined, PANEL_ID, { customResume, agentSessionId: CAPTURED_ID })).toBe(CAPTURED_ID);
    expect(resolveResumeId('claude', PANEL_ID, { customResume })).toBeUndefined();
  });

  it('returns undefined for unknown agents', () => {
    expect(resolveResumeId(undefined, PANEL_ID, {})).toBeUndefined();
  });
});
