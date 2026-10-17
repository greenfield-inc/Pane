import { describe, expect, it } from 'vitest';
import { detectAgentState } from './manifestEngine';
import {
  CLAUDE_MANIFEST,
  CODEX_MANIFEST,
  CURSOR_MANIFEST,
  GENERIC_MANIFEST,
  OPENCODE_MANIFEST,
  getManifestForAgent,
} from './manifests';
import { CLAUDE_API_ENOTFOUND_SCREEN, CLAUDE_API_RETRYING_SCREEN, CLAUDE_API_SLEEP_SCREEN } from './__fixtures__/claudeApiErrorScreens';

const screen = (s: string, oscTitle = '', oscProgress = '') => ({ screen: s, oscTitle, oscProgress });

describe('getManifestForAgent', () => {
  it('resolves bespoke manifests, with the generic fallback covering everything else', () => {
    expect(getManifestForAgent('claude')).toBe(CLAUDE_MANIFEST);
    expect(getManifestForAgent('codex')).toBe(CODEX_MANIFEST);
    expect(getManifestForAgent('cursor')).toBe(CURSOR_MANIFEST);
    expect(getManifestForAgent('opencode')).toBe(OPENCODE_MANIFEST);
    expect(getManifestForAgent('aider')).toBe(GENERIC_MANIFEST);
    expect(getManifestForAgent(undefined)).toBe(GENERIC_MANIFEST);
    expect(getManifestForAgent(null)).toBe(GENERIC_MANIFEST);
  });
});

describe('CLAUDE_MANIFEST', () => {
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

  // Claude Code 2.1.289 titles: "◐ Hi" / "◑ Hi" while a turn runs, "✳ Hi" between turns.
  it.each(['◐ Hi', '◑ Hi'])('sees the half-circle title %s as visible work over an idle prompt box', title => {
    const s = ['some prior output', '────────────', ' ❯ ', '────────────'].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s, title));
    expect(r.state).toBe('working');
    expect(r.visibleWorking).toBe(true);
  });

  it('keeps the star title between turns idle', () => {
    const s = ['some prior output', '────────────', ' ❯ ', '────────────'].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s, '✳ Hi'));
    expect(r.state).toBe('idle');
    expect(r.visibleWorking).toBe(false);
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
    expect(r.matchedRuleId).toBe('workspace_trust_prompt');
  });

  it('stops matching the folder-trust prompt once Claude exits to the shell below it', () => {
    const s = [
      '',
      '─'.repeat(100),
      ' Accessing workspace:',
      '',
      ' /tmp/untrusted-repo',
      '',
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      '',
      ' Enter to confirm · Esc to cancel',
      'parsas@host untrusted-repo % ',
    ].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.matchedRuleId).not.toBe('workspace_trust_prompt');
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
    expect(r.matchedRuleId).not.toBe('workspace_trust_prompt');
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

describe('CLAUDE_MANIFEST prompts seen in Claude Code 2.1.300', () => {
  it('classifies the external CLAUDE.md imports dialog as blocked', () => {
    const s = [
      ' p1-missing ?1 > claude --session-id 5c828cae-a5fd-4c8a-a3e9-afbe81f92fb4',
      '',
      '─'.repeat(80),
      '  Allow external CLAUDE.md file imports?',
      '',
      '  This project\'s CLAUDE.md or .claude/rules imports files outside the current',
      '  working directory. Never allow this for third-party repositories.',
      '',
      '  External imports:',
      '    /private/tmp/scratchpad/ext-memory.md',
      '',
      '  Important: Only use Claude Code with files you trust. Accessing untrusted',
      '  files may pose security risks https://code.claude.com/docs/en/security',
      '',
      '  ❯ No, disable external imports',
      '    Yes, allow external imports',
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
  });

  it('classifies a Bash permission prompt as blocked', () => {
    const s = [
      '─'.repeat(80),
      ' Bash command',
      ' Tip: auto mode handles these prompts for you — choose "switch to auto mode"',
      ' below',
      ' Create empty proof-permission.txt file',
      '╌'.repeat(80),
      ' touch proof-permission.txt',
      '╌'.repeat(80),
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and don’t ask again for: touch *',
      '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
      '   4. No',
      ' Esc to cancel · Tab to amend',
    ].join('\n');
    const r = detectAgentState(CLAUDE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
  });
});

describe('CODEX_MANIFEST', () => {
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

  // Real Codex 0.160.1 startup screens (Pane dev build, 2026-10-15).
  it.each([
    ['update offer', 'update_prompt', [
      '',
      '',
      '  Update available · 0.160.1 → 0.999.0',
      '  Release notes: https://github.com/openai/codex/releases/latest',
      '',
      '› 1. Update now (runs `brew upgrade --cask codex`)                              ',
      '  2. Skip',
      '  3. Skip until next version',
      '',
      '  enter continue · esc skip',
    ]],
    ['sign-in choice', 'sign_in_prompt', [
      '  Welcome to Codex, OpenAI\'s command-line coding agent',
      '',
      '  Sign in with ChatGPT to use Codex as part of your paid plan',
      '  or connect an API key for usage-based billing',
      ' ',
      '> 1. Sign in with ChatGPT',
      '     Usage included with Plus, Pro, Business, and Enterprise plans',
      '',
      '  2. Sign in with Device Code',
      '     Sign in from another device with a one-time code',
      '',
      '  3. Provide your own API key',
      '     Pay for what you use',
      '',
      '  Press enter to continue',
    ]],
    ['folder trust with the 0.160 footer', 'folder_trust_prompt', [
      '  Folder access',
      '  /tmp/rr-repo/worktrees/p1-missing',
      '',
      '  Note: You’re in a subdirectory of a Git project. Trusting will apply to the',
      '  repository root:',
      '  /tmp/rr-repo',
      '',
      '  Trust this folder? Codex can read, edit, and run files here, subject to your',
      '  permission settings. Folder settings can run code automatically, even',
      '  without a model request. Continue only if you trust these files. Your trust',
      '  decision will be saved.',
      '',
      '› 1. Trust and continue                                                         ',
      '  2. Back to Agent Command Center',
      '',
      '  enter continue · esc back',
    ]],
  ])('classifies the %s as blocked', (_name, ruleId, lines) => {
    const r = detectAgentState(CODEX_MANIFEST, screen(lines.join('\n')));
    expect(r.state).toBe('blocked');
    expect(r.matchedRuleId).toBe(ruleId);
    expect(r.visibleBlocker).toBe(true);
  });

  it('stops matching a startup prompt once Codex moved past it', () => {
    const s = [
      '  Update available · 0.160.1 → 0.999.0',
      '  3. Skip until next version',
      '  enter continue · esc skip',
      '',
      '› Summarize recent commits',
      '',
      '  gpt-5.5 default · ~/repo',
    ].join('\n');
    expect(detectAgentState(CODEX_MANIFEST, screen(s)).matchedRuleId).not.toBe('update_prompt');
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

// Minimal fixtures distilled from isolated OpenCode v2.0.19 PTY captures.
describe('OPENCODE_MANIFEST', () => {
  const permissionChoices = '  ┃   Allow once   Always allow   Reject';
  const permissionConfirmationFooter =
    '  ┃   ctrl+f fullscreen  ⇆ select  enter confirm';
  const permissionOneLineFooter =
    '  ┃   Allow once   Always allow   Reject   ctrl+f fullscreen  ⇆ select  enter confirm';
  const idleComposer = [
    '  ┃',
    '  ┃  Ask anything…',
    '  ┃',
    '  ┃  Build',
    `  ╹${'▀'.repeat(44)}`,
    '  [project]                          shift+tab agents  ctrl+p commands',
  ].join('\n');

  it('leaves the blank pre-render startup frame idle for monitor startup grace', () => {
    const r = detectAgentState(OPENCODE_MANIFEST, screen(''));
    expect(r.state).toBe('idle');
    expect(r.visibleIdle).toBe(false);
    expect(r.matchedRuleId).toBeNull();
  });

  it('classifies the rendered startup composer as idle', () => {
    const r = detectAgentState(OPENCODE_MANIFEST, screen(idleComposer, 'OpenCode'));
    expect(r.state).toBe('idle');
    expect(r.visibleIdle).toBe(true);
    expect(r.matchedRuleId).toBe('idle_composer');
  });

  it('recognizes a transparent-theme composer without an opaque bottom border', () => {
    const r = detectAgentState(OPENCODE_MANIFEST, screen(idleComposer.replace(/╹▀+/u, ' '), 'OpenCode'));
    expect(r.visibleIdle).toBe(true);
    expect(r.matchedRuleId).toBe('idle_composer');
  });

  it.each([
    '  ⬝⬝■■■■ esc interrupt                    shift+tab agents  ctrl+p commands',
    '  ■■⬝⬝⬝⬝ esc again to interrupt           shift+tab agents  ctrl+p commands',
  ])('classifies a live working footer as working: %s', (footer) => {
    const s = ['⠙ New session', '', '  ┃  Build', `  ╹${'▀'.repeat(44)}`, footer].join('\n');
    const r = detectAgentState(OPENCODE_MANIFEST, screen(s, 'OpenCode'));
    expect(r.state).toBe('working');
    expect(r.visibleWorking).toBe(true);
    expect(r.matchedRuleId).toBe('interruptible_composer');
  });

  it('classifies the split-line live permission action as blocked', () => {
    const s = [
      '  ┃  △ Permission required',
      '  ┃',
      '  ┃  $ sanitized-command',
      '  ┃',
      permissionChoices,
      permissionConfirmationFooter,
    ].join('\n');
    const r = detectAgentState(OPENCODE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.visibleBlocker).toBe(true);
    expect(r.matchedRuleId).toBe('live_permission_action');
  });

  it('classifies the captured one-line live permission action as blocked', () => {
    const s = ['  ┃  △ Permission required', '  ┃  $ sanitized-command', permissionOneLineFooter].join('\n');
    const r = detectAgentState(OPENCODE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.matchedRuleId).toBe('live_permission_action');
  });

  it('keeps a wrapped live permission action blocked beyond the old eight-line boundary', () => {
    const s = [
      '  ┃  △ Permission required',
      '  ┃  $ sanitized-command --first',
      '  ┃    --second',
      '  ┃    --third',
      '  ┃    --fourth',
      '  ┃  Review the requested action.',
      '  ┃  Only the displayed action is affected.',
      '  ┃  Choose how to continue.',
      permissionChoices,
      permissionConfirmationFooter,
    ].join('\n');
    const r = detectAgentState(OPENCODE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.matchedRuleId).toBe('live_permission_action');
  });

  it('prioritizes the live permission footer over coexisting working and idle markers', () => {
    const s = [
      `  ╹${'▀'.repeat(44)}`,
      '  ⬝⬝■■■■ esc interrupt                    shift+tab agents  ctrl+p commands',
      permissionChoices,
      permissionConfirmationFooter,
    ].join('\n');
    const r = detectAgentState(OPENCODE_MANIFEST, screen(s));
    expect(r.state).toBe('blocked');
    expect(r.matchedRuleId).toBe('live_permission_action');
  });

  it('classifies a session error above the current idle composer as idle', () => {
    const s = ['  Session failed  x', '  Error: fixture rejected request', '', idleComposer].join('\n');
    const r = detectAgentState(OPENCODE_MANIFEST, screen(s));
    expect(r.state).toBe('idle');
    expect(r.matchedRuleId).toBe('idle_composer');
  });

  it('does not treat action-looking history at the old eight-line boundary as a live blocker', () => {
    const s = [
      permissionChoices,
      permissionConfirmationFooter,
      idleComposer,
    ].join('\n');
    const r = detectAgentState(OPENCODE_MANIFEST, screen(s));
    expect(r.state).toBe('idle');
    expect(r.matchedRuleId).toBe('idle_composer');
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

describe('CLAUDE_MANIFEST API errors seen in Claude Code 2.1.302', () => {
  // An agent-farm worker that loses the network or sleeps mid-turn ends here; the turn must read as
  // over (idle), so READY fires and a missing report can be raised, while a retry is still work.
  it('keeps a turn that is still retrying the API as working', () => {
    for (const title of ['', '✳ Claude Code']) {
      expect(detectAgentState(CLAUDE_MANIFEST, screen(CLAUDE_API_RETRYING_SCREEN, title)).state).toBe('working');
    }
  });

  it('reads a turn that ended on a network error or a sleep as idle', () => {
    for (const s of [CLAUDE_API_ENOTFOUND_SCREEN, CLAUDE_API_SLEEP_SCREEN]) {
      for (const title of ['', '✳ Claude Code']) {
        expect(detectAgentState(CLAUDE_MANIFEST, screen(s, title))).toMatchObject({ state: 'idle', matchedRuleId: 'live_prompt_box' });
      }
    }
  });
});
