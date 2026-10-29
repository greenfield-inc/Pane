import { describe, expect, it } from 'vitest';
import { terminalLines } from '../src/screens';
import { trimChrome } from '../src/terminal';

const rule = (width: number, char = '─') => char.repeat(width);

describe('trimming the input box from a terminal screen', () => {
  it('shows the output above a Claude Code-style box and the status rows under it', () => {
    const screen = [
      '⏺ Fixed the retry in src/auth/refresh.ts.',
      '  All 12 auth tests pass.',
      '',
      rule(100),
      '> ',
      rule(100),
      '  __orchestration_session_8020ff4b__ | Opus 5.5 / medium | ctx 27% | $10.62 | 106m',
      '  ⏵⏵ bypass permissions on · 2 shells',
      '',
      '',
    ];
    expect(trimChrome(screen)).toEqual(['⏺ Fixed the retry in src/auth/refresh.ts.', '  All 12 auth tests pass.']);
  });

  it('shows the output above a Codex-style rounded box and its hint row', () => {
    const screen = [
      '• Ran pnpm test',
      '  └ 86 passed',
      '',
      `╭${rule(78)}╮`,
      `│ ▌ Ask Codex to do anything${' '.repeat(51)}│`,
      `╰${rule(78)}╯`,
      '  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit   100% context left',
    ];
    expect(trimChrome(screen)).toEqual(['• Ran pnpm test', '  └ 86 passed']);
  });

  it('leaves a plain shell alone, including a short rule in its output', () => {
    const screen = ['$ git log --oneline -2', '8d63c5f Glasses: keep your place', '───', '14ea64b Teach the pane home skill', '$ '];
    expect(trimChrome(screen)).toEqual(screen);
  });

  it('hides a footer with no rule once it stays the same while the output above it changes', () => {
    const footer = ['  ? for shortcuts', '  12k tokens · esc to interrupt'];
    const reads = [['building 1/3', ...footer], ['building 2/3', ...footer], ['building 3/3', ...footer]];
    expect(trimChrome(['done', ...footer], reads)).toEqual(['done']);
    // A screen that never changes is left whole.
    expect(trimChrome(['done', ...footer], [['done', ...footer], ['done', ...footer]])).toEqual(['done', ...footer]);
  });
});

describe('terminal lines', () => {
  it('draws a rule wider than the glasses as one line instead of wrapping it', () => {
    const lines = terminalLines(['before', rule(200), 'after']);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^─+…?$/);
  });
});
