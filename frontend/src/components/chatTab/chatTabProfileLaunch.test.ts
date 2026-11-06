import { describe, expect, it } from 'vitest';
import { chatTabProfileLaunch } from '../../../../shared/chatTabProfileLaunch';

describe('chatTabProfileLaunch', () => {
  it('sends the profile alone when there are no arguments', () => {
    expect(chatTabProfileLaunch('  greenfield/implementer ', '\n  \n')).toEqual({ ok: true, launch: { kind: 'profile', profile: 'greenfield/implementer' } });
  });

  it('reads one key=value per line, like runpane --arg', () => {
    expect(chatTabProfileLaunch('greenfield/implementer', 'ticket=PANE-12\r\n model = opus\nquery=a=b c\n')).toEqual({
      ok: true,
      launch: { kind: 'profile', profile: 'greenfield/implementer', args: { ticket: 'PANE-12', model: ' opus', query: 'a=b c' } },
    });
  });

  it('asks for a profile name', () => {
    expect(chatTabProfileLaunch('   ', '')).toMatchObject({ ok: false, field: 'profile' });
    expect(chatTabProfileLaunch('greenfield implementer', '')).toMatchObject({ ok: false, field: 'profile' });
  });

  it('names the line that is not key=value', () => {
    expect(chatTabProfileLaunch('p', 'ticket=1\njust text')).toEqual({ ok: false, field: 'args', error: '"just text" is not an argument. Write one key=value per line.' });
    expect(chatTabProfileLaunch('p', '=value')).toMatchObject({ ok: false, field: 'args' });
  });
});
