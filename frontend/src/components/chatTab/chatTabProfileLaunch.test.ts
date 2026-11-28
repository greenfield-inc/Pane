import { describe, expect, it } from 'vitest';
import { chatTabProfileExample, chatTabProfileLaunch, chatTabProfileOptions } from '../../../../shared/chatTabProfileLaunch';
import type { AgentFarmProfileEntry } from '../../../../shared/types/agentFarmProfiles';

const entry = (ref: string, extra: Partial<AgentFarmProfileEntry> = {}): AgentFarmProfileEntry => ({
  ref, plugin: ref.split('/')[0], version: '0.1.0', harness: 'claude', hidden: ref.startsWith('pane/'), ...extra,
});

describe('chatTabProfileOptions', () => {
  it('offers every profile Agent Farm lists by title and ref, Pane\'s own left out, and each other variant', () => {
    expect(chatTabProfileOptions([
      entry('pane/claude'),
      entry('greenfield/orchestrator', { title: 'Orchestrator', defaultVariant: 'claude', variants: [{ name: 'claude', model: 'opus' }, { name: 'codex', model: 'gpt' }] }),
      entry('greenfield/seo'),
    ])).toEqual([
      { ref: 'greenfield/orchestrator', label: 'Orchestrator · greenfield/orchestrator' },
      { ref: 'greenfield/orchestrator:codex', label: 'Orchestrator (Codex) · greenfield/orchestrator:codex' },
      { ref: 'greenfield/seo', label: 'Greenfield seo · greenfield/seo' },
    ]);
  });
});

describe('chatTabProfileLaunch', () => {
  it('sends the profile alone when there are no arguments', () => {
    expect(chatTabProfileLaunch('  greenfield/orchestrator ', '\n  \n')).toEqual({ ok: true, launch: { kind: 'profile', profile: 'greenfield/orchestrator' } });
  });

  it('reads one key=value per line, like runpane --arg', () => {
    expect(chatTabProfileLaunch('greenfield/orchestrator', 'ticket=PANE-12\r\n model = opus\nquery=a=b c\n')).toEqual({
      ok: true,
      launch: { kind: 'profile', profile: 'greenfield/orchestrator', args: { ticket: 'PANE-12', model: ' opus', query: 'a=b c' } },
    });
  });

  it('asks for a profile name', () => {
    expect(chatTabProfileLaunch('   ', '')).toMatchObject({ ok: false, field: 'profile' });
    expect(chatTabProfileLaunch('greenfield implementer', '')).toMatchObject({ ok: false, field: 'profile' });
  });

  it('keeps the example on main with Profiles off, and greenfield 0.1.0\'s entry profile with it on (review F-2)', () => {
    expect(chatTabProfileExample(false)).toBe('greenfield/implementer');
    expect(chatTabProfileLaunch('', '')).toEqual({ ok: false, field: 'profile', error: 'Enter a profile name, such as greenfield/implementer.' });
    expect(chatTabProfileLaunch('', '', { profilesOn: false })).toEqual({ ok: false, field: 'profile', error: 'Enter a profile name, such as greenfield/implementer.' });
    expect(chatTabProfileExample(true)).toBe('greenfield/orchestrator');
    expect(chatTabProfileLaunch('', '', { profilesOn: true })).toEqual({ ok: false, field: 'profile', error: 'Enter a profile name, such as greenfield/orchestrator.' });
  });

  it('names the line that is not key=value', () => {
    expect(chatTabProfileLaunch('p', 'ticket=1\njust text')).toEqual({ ok: false, field: 'args', error: '"just text" is not an argument. Write one key=value per line.' });
    expect(chatTabProfileLaunch('p', '=value')).toMatchObject({ ok: false, field: 'args' });
  });
});
