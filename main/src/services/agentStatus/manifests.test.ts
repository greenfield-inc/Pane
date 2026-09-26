import { describe, expect, it } from 'vitest';
import { detectAgentState } from './manifestEngine';
import {
  CLAUDE_MANIFEST,
  CODEX_MANIFEST,
  CURSOR_MANIFEST,
  GENERIC_MANIFEST,
  getManifestForAgent,
} from './manifests';

const screen = (s: string, oscTitle = '', oscProgress = '') => ({ screen: s, oscTitle, oscProgress });

describe('getManifestForAgent', () => {
  it('resolves bespoke manifests, with the generic fallback covering everything else', () => {
    expect(getManifestForAgent('claude')).toBe(CLAUDE_MANIFEST);
    expect(getManifestForAgent('codex')).toBe(CODEX_MANIFEST);
    expect(getManifestForAgent('cursor')).toBe(CURSOR_MANIFEST);
    expect(getManifestForAgent('aider')).toBe(GENERIC_MANIFEST);
    expect(getManifestForAgent(undefined)).toBe(GENERIC_MANIFEST);
    expect(getManifestForAgent(null)).toBe(GENERIC_MANIFEST);
  });
});

describe('CLAUDE_MANIFEST', () => {
  it.each(['◐', '◑', '◒', '◓', '⠙'])('recognizes Claude working title %s', (glyph) => {
    expect(detectAgentState(CLAUDE_MANIFEST, screen('', `${glyph} Building`)).state).toBe('working');
  });

  it.each(['· Flowing…', '✶ Jitterbugging…', '✶ Jitterbugging… (2s · ↓ 10 tokens)'])('recognizes live status %s', (line) => {
    expect(detectAgentState(CLAUDE_MANIFEST, screen(`${line}\n────────────\n❯ text\n────────────`)).state).toBe('working');
  });

  it('does not mistake completed summaries or arbitrary titles for working', () => {
    expect(detectAgentState(CLAUDE_MANIFEST, screen('✻ Brewed for 0s · done 10:28 PM', 'Project')).state).toBe('idle');
  });

  it('prioritizes permission and trust prompts over working titles', () => {
    for (const prompt of [
      'Bash command\nDo you want to proceed?\n❯ 1. Yes\n2. No',
      '────────────\nDo you want to proceed?\n❯ 1. Yes\n2. No (esc to cancel)',
      'Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\nYes, I trust this folder\nEnter to confirm · Esc to cancel',
    ]) {
      expect(detectAgentState(CLAUDE_MANIFEST, screen(prompt, '◐ Building')).state).toBe('blocked');
    }
  });

  it('ignores an answered permission above the current composer', () => {
    const text = 'Bash command\nDo you want to proceed?\n❯ 1. Yes\n2. No\nDone.\n────────────\n❯ next task\n────────────';
    expect(detectAgentState(CLAUDE_MANIFEST, screen(text, '✳ Project')).state).toBe('idle');
    expect(detectAgentState(CLAUDE_MANIFEST, screen(text, '◐ Building')).state).toBe('working');
  });

  it('classifies a bash permission prompt as blocked', () => {
    const s = [
      '● I will run a command',
      '',
      'Bash command',
      '  ls -la',
      '',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No, and tell Claude what to do differently (esc)',
    ].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
  });

  it('classifies a generic permission prompt after a rule as blocked', () => {
    const s = [
      'context',
      '──────────────────────',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. No (esc to cancel)',
    ].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
  });

  it('classifies an empty prompt box as idle via live_prompt_box', () => {
    const s = ['some prior output', '────────────', ' ❯ ', '────────────'].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('idle');
    expect(r.matchedRuleId).toBe('live_prompt_box');
  });

  // Real Claude Code 2.1.282 screens from launching in an untrusted folder.
  it('classifies the folder-trust prompt as blocked', () => {
    const s = [
      '',
      '─'.repeat(100),
      ' Accessing workspace:',
      '',
      ' /tmp/untrusted-repo',
      '',
      " Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
      " well-known open source project, or work from your team). If not, take a moment to review what's in",
      ' this folder first.',
      '',
      " Claude Code'll be able to read, edit, and execute files here.",
      '',
      ' Security guide',
      '',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
    ].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
  });

  // Real Claude Code 2.1.282 startup screens: bypass-permissions warning and first-run setup.
  it.each([
    [
      'bypass-permissions warning',
      [
        '─'.repeat(100),
        '  WARNING: Claude Code running in Bypass Permissions mode',
        '',
        '  In Bypass Permissions mode, Claude Code will not ask for your approval before running',
        '  potentially dangerous commands.',
        '',
        '  ❯ No, exit',
        '    Yes, I accept',
        '',
        '  Enter to confirm · Esc to cancel',
      ],
    ],
    [
      'theme picker',
      [
        ' Let\'s get started.',
        '',
        ' Choose the text style that looks best with your terminal',
        ' To change this later, run /theme',
        '',
        '   1. Auto (match terminal)',
        ' ❯ 2. Dark mode ✔',
        '   3. Light mode',
        '',
        ' ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
        '  1  function greet() {',
        '  2 -  console.log("Hello, World!");',
        '  2 +  console.log("Hello, Claude!");',
        '  3  }',
        ' ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
        '  Syntax theme: Monokai Extended (ctrl+t to disable)',
      ],
    ],
    [
      'login method picker',
      [
        ' Select login method:',
        '',
        ' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise',
        '   2. Anthropic Console account · API usage billing',
        '   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI',
      ],
    ],
    [
      'login code prompt',
      [
        ' Browser didn\'t open? Use the url below to sign in (c to copy)',
        '',
        'https://claude.com/cai/oauth/authorize?code=true',
        '',
        ' Paste code here if prompted >',
      ],
    ],
  ])('classifies the %s as blocked', (_name, lines) => {
    const r = detectAgentState(CLAUDE_MANIFEST, screen(lines.join('\n')));
    expect(r.state).toBe('blocked');
  });

  it('classifies the fresh prompt box after trusting the folder as idle', () => {
    const s = [
      ' ▐▛███▛█   Claude Code v2.1.282',
      '▝▜██████▀  Opus 5.5 (1M context) · Claude Max',
      ' ▝▝   ▝▝   /tmp/untrusted-repo',
      '',
      '                                                                                ◐ medium · /effort',
      '─'.repeat(100),
      '❯ Try "how do I log an error?"',
      '─'.repeat(100),
      '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
    ].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s, '✳ Claude Code'));
    expect(r.state).toBe('idle');
  });

  it('detects working from a braille-spinner OSC title', () => {
    const r = detectAgentState(CLAUDE_MANIFEST, screen('', '⠙ Building the thing'));
    expect(r.state).toBe('working');
    expect(r.visibleWorking).toBe(true);
  });

  it('detects high-effort thinking redraws as working', () => {
    const s = [
      '· Newspapering… (3m 52s · ↓ 5.9k tokens · thinking with high effort)',
      'esc to interrupt',
      '────────────────────',
      ' ❯ ',
    ].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('working');
    expect(r.visibleWorking).toBe(true);
    expect(r.matchedRuleId).toBe('high_effort_thinking_working');
  });

  it.each([
    'Connection lost while your computer was asleep · Retrying in 0s · attempt 3/10',
    'API error · Retrying in 0s · attempt 1/10',
    'Connection dropped (ECONNRESET) · Retrying in 0s · attempt 4/10',
  ])('keeps retry banners working: %s', (banner) => {
    const s = [banner, '────────────────────', ' ❯ ', '────────────────────'].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('working');
    expect(r.visibleWorking).toBe(true);
    expect(r.matchedRuleId).toBe('api_retry_working');
  });

  it('does not treat a terminal API Error line as a live retry banner', () => {
    const s = ['API Error: request failed', '────────────────────', ' ❯ ', '────────────────────'].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('idle');
    expect(r.matchedRuleId).toBe('live_prompt_box');
  });

  it('detects idle from the ✳ OSC title', () => {
    const r = detectAgentState(CLAUDE_MANIFEST, screen('', '✳ Ready'));
    expect(r.state).toBe('idle');
  });

  it('holds prior state on the transcript viewer', () => {
    const s = ['Showing detailed transcript (ctrl+o to toggle)'].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.skipStateUpdate).toBe(true);
    expect(r.matchedRuleId).toBe('transcript_viewer');
  });
});

describe('CODEX_MANIFEST', () => {
  it.each([
    'The script asks [y/n].\n› ',
    'Do you want to continue? Say yes.\n› ',
    '› Explain this\nThe documentation says [y/n].\n› next question',
  ])('ignores completed prose containing prompt text: %s', (text) => {
    expect(detectAgentState(CODEX_MANIFEST, screen(text, 'Codex')).state).toBe('idle');
  });

  it.each([1, 2, 3])('treats the update prompt as blocked with option %i selected', (selected) => {
    const options = ['1. Update now (runs `sh -c \'curl -fsSL https://chatgpt.com/codex/install.sh | sh\'`)', '2. Skip', '3. Skip until next version'];
    const menu = options.map((option, index) => `${index + 1 === selected ? '›' : ' '} ${option}`).join('\n');
    const text = `Update available · 0.156.1 → 0.157.1\nRelease notes: https://github.com/openai/codex/releases/latest\n\n${menu}\n\nenter continue · esc skip`;
    expect(detectAgentState(CODEX_MANIFEST, screen(text)).state).toBe('blocked');
  });

  it('recognizes wrapped working chrome', () => {
    expect(detectAgentState(CODEX_MANIFEST, screen('• Working (5s • esc to\n  interrupt)\n› ')).state).toBe('working');
  });

  it.each(['q close', 'q to quit'])('holds transcript viewer state with %s', (close) => {
    expect(detectAgentState(CODEX_MANIFEST, screen(`↑/↓ to scroll · pgup/pgdn to page · home/end to jump\n${close} · esc to edit prev`)).skipStateUpdate).toBe(true);
  });

  it('classifies the Action Required title as blocked', () => {
    const r = detectAgentState(CODEX_MANIFEST, screen('working on it', 'Action Required · Codex'));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
  });

  it('detects working from a codex spinner OSC title', () => {
    const r = detectAgentState(CODEX_MANIFEST, screen('', '⠹ Codex'));
    expect(r.state).toBe('working');
  });

  it('classifies an allow-command prompt as blocked', () => {
    const s = ['Codex wants to run a command', 'allow command?', '  Yes    No'].join('\n');
    const r = detectAgentState(CODEX_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
  });

  // Real Codex 0.156.1 screen from launching in an untrusted folder; the title is still empty.
  it('classifies the folder-trust prompt as blocked', () => {
    const s = [
      '',
      '  Folder access',
      '  /tmp/untrusted-repo',
      '',
      '  Trust this folder? Codex can read, edit, and run files here, subject to your permission',
      '  settings. Folder settings can run code automatically, even without a model request. Continue',
      '  only if you trust these files. Your trust decision will be saved.',
      '',
      '› 1. Trust and continue',
      '  2. Quit',
      '',
      '  enter continue · esc quit',
    ].join('\n');
    const r = detectAgentState(CODEX_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
  });

  // Real Codex 0.156.1 boot frame: the composer shows before the trust prompt replaces it.
  it('classifies the boot screen as working, not idle', () => {
    const s = [
      '╭───────────────────────────────────────╮',
      '│ >_ OpenAI Codex (v0.156.1)            │',
      '│                                       │',
      '│ model:     loading   /model to change │',
      '│ directory: loading                    │',
      '╰───────────────────────────────────────╯',
      '› Ask Codex to do anything',
    ].join('\n');
    const r = detectAgentState(CODEX_MANIFEST, screen(s));
    expect(r.state).toBe('working');
  });

  it('classifies a [y/n] weak blocker as blocked', () => {
    const r = detectAgentState(CODEX_MANIFEST, screen('Continue? [y/n]'));
    expect(r.state).toBe('blocked');
  });

  it('detects working from the "Working (… esc to interrupt)" status line', () => {
    const s = ['some output', '• Working (5s • esc to interrupt) · thinking'].join('\n');
    const r = detectAgentState(CODEX_MANIFEST, screen(s));
    expect(r.state).toBe('working');
  });

  it('classifies a plain title as idle', () => {
    const r = detectAgentState(CODEX_MANIFEST, screen('', 'Codex'));
    expect(r.state).toBe('idle');
  });
});

// Fixtures below are distilled from real cursor-agent 2026.08.11-e8db854 screens.
describe('CURSOR_MANIFEST', () => {
  it('classifies the workspace-trust dialog as blocked', () => {
    const s = [
      '  ╭──────────────────────────────────────────────────╮',
      '  │  ⚠ Workspace Trust Required                      │',
      '  │  Cursor Agent can execute code and access files  │',
      '  │  in this directory.                              │',
      '  │  Do you trust the contents of this directory?    │',
      '  │  ▶ [a] Trust this workspace                      │',
      '  │    [q] Quit                                      │',
      '  ╰──────────────────────────────────────────────────╯',
    ].join('\n');
    const r = detectAgentState(CURSOR_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
    expect(r.matchedRuleId).toBe('workspace_trust_prompt');
  });

  it('classifies a shell-approval prompt as blocked', () => {
    const s = [
      '  $ rm -f probe-none.txt Waiting for approval...',
      '────────────────────────────────────────────────────',
      ' $  rm -f probe-none.txt in .',
      ' Run this command?',
      ' Not in allowlist: rm',
      '  → Run (once) (y)',
      '    Add Shell(rm) to allowlist? (tab)',
      '    Run Everything (shift+tab)',
      '    Skip & tell the agent what to do instead (esc or n)',
    ].join('\n');
    const r = detectAgentState(CURSOR_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
    expect(r.matchedRuleId).toBe('live_approval_prompt');
  });

  it('detects working from the braille spinner status line', () => {
    const s = [
      '  Add a note to the README',
      ' ⠘⠤ Working  410 tokens',
      ' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
      '  → Add a follow-up                    ctrl+c to stop',
      ' ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '  /repo/path | Gemini 3.5 Flash',
    ].join('\n');
    const r = detectAgentState(CURSOR_MANIFEST, screen(s));
    expect(r.state).toBe('working');
    expect(r.visibleWorking).toBe(true);
  });

  it('detects working while the shell tool runs, via the interruptible composer', () => {
    const s = [
      '  $ sleep 5 in .',
      ' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
      '  → Add a follow-up                    ctrl+c to stop',
      ' ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '  /repo/path | Gemini 3.5 Flash',
    ].join('\n');
    const r = detectAgentState(CURSOR_MANIFEST, screen(s));
    expect(r.state).toBe('working');
  });

  it('detects working while a resumed conversation loads', () => {
    const s = [
      '  ⠀⠞ Loading conversation',
      ' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
      '  ⌆ Plan, search, build anything',
      ' ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
    ].join('\n');
    const r = detectAgentState(CURSOR_MANIFEST, screen(s));
    expect(r.state).toBe('working');
  });

  it('classifies the fresh composer as idle', () => {
    const s = [
      '  Cursor Agent',
      '  v2026.08.11-e8db854',
      '  Tip: Use /skills to give Cursor specialized knowledge for tasks.',
      ' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
      '  ⌆ Plan, search, build anything',
      ' ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '  /repo/path | Gemini 3.5 Flash',
    ].join('\n');
    const r = detectAgentState(CURSOR_MANIFEST, screen(s));
    expect(r.state).toBe('idle');
    expect(r.visibleIdle).toBe(true);
  });

  it('classifies the post-response composer as idle', () => {
    const s = [
      '  done-marker.',
      ' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
      '  → Add a follow-up',
      ' ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '  /repo/path | Gemini 3.5 Flash | ctx 11%',
    ].join('\n');
    const r = detectAgentState(CURSOR_MANIFEST, screen(s));
    expect(r.state).toBe('idle');
  });

  it('does not stay blocked once an answered approval scrolls above the live composer', () => {
    const s = [
      '  $ rm -f probe-none.txt Waiting for approval...',
      '────────────────────────────────────────────────────',
      '  I have deleted the file.',
      ' ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄',
      '  → Add a follow-up',
      ' ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀',
      '  /repo/path | Gemini 3.5 Flash',
    ].join('\n');
    const r = detectAgentState(CURSOR_MANIFEST, screen(s));
    expect(r.state).toBe('idle');
  });
});

describe('GENERIC_MANIFEST', () => {
  it('detects a live prompt on the last line as blocked', () => {
    expect(detectAgentState(GENERIC_MANIFEST, screen('Overwrite file? (y/n)')).state).toBe('blocked');
    expect(detectAgentState(GENERIC_MANIFEST, screen('Do you want to proceed? [y/n] ')).state).toBe('blocked');
    expect(
      detectAgentState(GENERIC_MANIFEST, screen('Apply migration to database?\nDo you want to proceed? [y/n] ')).state,
    ).toBe('blocked');
    expect(detectAgentState(GENERIC_MANIFEST, screen('Continue? [Y/n]:')).state).toBe('blocked');
  });

  it('does not stay blocked once the prompt is answered or scrolled past', () => {
    expect(detectAgentState(GENERIC_MANIFEST, screen('Do you want to proceed? [y/n] y\nok: y')).state).toBe('idle');
    expect(detectAgentState(GENERIC_MANIFEST, screen('Overwrite file? (y/n)\n$ ')).state).toBe('idle');
    expect(detectAgentState(GENERIC_MANIFEST, screen('$ ')).state).toBe('idle');
  });
});
