import { describe, expect, it } from 'vitest';
import { profileAvatar, profileDisplayName } from './profileAvatar';

describe('profileAvatar', () => {
  it('shows a plain Claude or Codex Session, and one from before profiles, as its agent logo', () => {
    expect(profileAvatar({ profileRef: 'pane/claude' })).toEqual({ kind: 'logo', agent: 'claude' });
    expect(profileAvatar({ profileRef: 'pane/codex' })).toEqual({ kind: 'logo', agent: 'codex' });
    expect(profileAvatar({ agent: 'codex' })).toEqual({ kind: 'logo', agent: 'codex' });
  });

  it('shows another agent by its initial', () => {
    expect(profileAvatar({ agent: 'cursor' })).toEqual({ kind: 'letter', text: 'C' });
    expect(profileAvatar({ agent: 'opencode' })).toEqual({ kind: 'letter', text: 'O' });
  });

  it('shows a profile as its initials on one of eight tints, the same tint every time', () => {
    const first = profileAvatar({ profileRef: 'dcouple/business' });
    expect(first).toMatchObject({ kind: 'initials', text: 'DB' });
    expect(profileAvatar({ profileRef: 'dcouple/business' })).toEqual(first);
    const tones = new Set(['greenfield/orchestrator', 'greenfield/planner', 'dcouple/business', 'a/b', 'x/y', 'm/n'].map(ref => {
      const avatar = profileAvatar({ profileRef: ref });
      return avatar.kind === 'initials' ? avatar.tone : 0;
    }));
    for (const tone of tones) expect(tone).toBeGreaterThanOrEqual(1);
    for (const tone of tones) expect(tone).toBeLessThanOrEqual(8);
    expect(tones.size).toBeGreaterThan(1);
  });

  it('keeps a variant on the profile it belongs to', () => {
    expect(profileAvatar({ profileRef: 'greenfield/orchestrator:codex' })).toEqual(profileAvatar({ profileRef: 'greenfield/orchestrator' }));
  });

  it('uses two letters of a profile named like its plugin', () => {
    expect(profileAvatar({ profileRef: 'writer/writer' })).toMatchObject({ text: 'WR' });
  });

  it('shows a picture when there is one, over everything else', () => {
    expect(profileAvatar({ profileRef: 'greenfield/orchestrator', picture: 'file:///a.png' })).toEqual({ kind: 'picture', src: 'file:///a.png' });
  });
});

describe('profileDisplayName', () => {
  it('names a profile by its plugin and profile, and a plain one by its agent', () => {
    expect(profileDisplayName('greenfield/orchestrator')).toBe('Greenfield orchestrator');
    expect(profileDisplayName('writer/writer')).toBe('Writer');
    expect(profileDisplayName('pane/claude')).toBe('Claude');
    expect(profileDisplayName('greenfield/orchestrator:codex')).toBe('Greenfield orchestrator (codex)');
  });
});
