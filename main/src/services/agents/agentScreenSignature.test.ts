import { describe, expect, it } from 'vitest';
import { detectAgentBackgroundWork, detectAgentComposer, detectAgentFromScreen, screenShowsQueuedMessage } from './agentScreenSignature';
import { CLAUDE_API_ENOTFOUND_SCREEN, CLAUDE_API_SLEEP_SCREEN } from '../agentStatus/__fixtures__/claudeApiErrorScreens';

const rule = '─'.repeat(40);

describe('detectAgentFromScreen', () => {
  it('recognises Claude by its closed composer box', () => {
    expect(detectAgentFromScreen(`✻ Done\n${rule}\n❯ \n${rule}\n  ? for shortcuts`)).toBe('claude');
    expect(detectAgentFromScreen(`${rule}\n❯ half-typed prompt\n${rule}`)).toBe('claude');
  });

  it('does not take a shell prompt or a Claude menu for the composer box', () => {
    expect(detectAgentFromScreen('~/repo on main\n❯ ')).toBeUndefined();
    expect(detectAgentFromScreen(`${rule}\n❯ `)).toBeUndefined();
    expect(detectAgentFromScreen(`${rule}\n Accessing workspace:\n\n ❯ No, exit\n   Yes, I trust this folder`)).toBeUndefined();
  });

  it('recognises Codex by its header and prompt', () => {
    const codex = '╭────────────╮\n│ >_ OpenAI Codex (v0.157.1) │\n╰────────────╯\n\n› Ask Codex to do anything\n';
    expect(detectAgentFromScreen(codex)).toBe('codex');
    expect(detectAgentFromScreen('› Ask Codex to do anything\n')).toBeUndefined();
    expect(detectAgentFromScreen('OpenAI Codex docs\n$ ')).toBeUndefined();
  });

  // A wrapper (`agent-farm run`) can start the agent in a folder it has not trusted yet (#743).
  it("recognises Claude and Codex by their folder-trust prompts", () => {
    const claudeTrust = [
      rule,
      ' Accessing workspace:',
      ' /tmp/untrusted-repo',
      " Quick safety check: Is this a project you created or one you trust? (Like your",
      " Claude Code'll be able to read, edit, and execute files here.",
      ' ❯ No, exit',
      '   Yes, I trust this folder',
      ' Enter to confirm · Esc to cancel',
    ].join('\n');
    expect(detectAgentFromScreen(claudeTrust)).toBe('claude');
    const codexTrust = [
      '  Folder access',
      '  Trust this folder? Codex can read, edit, and run files here, subject to your permission',
      '› 1. Trust and continue',
      '  2. Quit',
      '  enter continue · esc quit',
    ].join('\n');
    expect(detectAgentFromScreen(codexTrust)).toBe('codex');
  });

  it('ignores empty screens', () => {
    expect(detectAgentFromScreen(undefined)).toBeUndefined();
    expect(detectAgentFromScreen('')).toBeUndefined();
  });
});

describe('detectAgentComposer', () => {
  it('reads held text in the Claude and Codex composers', () => {
    expect(detectAgentComposer(`${rule}\n❯ ship it\n${rule}`, 'claude')).toEqual({ isPresent: true, hasUndeliveredText: true });
    expect(detectAgentComposer(`${rule}\n❯ \n${rule}`, 'claude')).toEqual({ isPresent: true, hasUndeliveredText: false });
    expect(detectAgentComposer('› Ask Codex to do anything', 'codex')).toEqual({ isPresent: true, hasUndeliveredText: false });
    expect(detectAgentComposer('› run tests', 'codex')).toEqual({ isPresent: true, hasUndeliveredText: true });
    expect(detectAgentComposer('model:     loading\n› ', 'codex')).toEqual({ isPresent: false, hasUndeliveredText: false });
  });

  it('reports no composer for agents Pane cannot read', () => {
    expect(detectAgentComposer(`${rule}\n❯ ship it\n${rule}`, 'cursor')).toEqual({ isPresent: false, hasUndeliveredText: false });
    expect(detectAgentComposer(`${rule}\n❯ ship it\n${rule}`, undefined)).toEqual({ isPresent: false, hasUndeliveredText: false });
  });
});

describe('detectAgentComposer with typed and ghost layers', () => {
  it('reads a Claude suggestion as ghost text, not held input, and keeps real typed text', () => {
    const text = `✻ Done\n${rule}\n❯ merge it\n${rule}\n  ? for shortcuts`;
    const typedText = `✻ Done\n${rule}\n❯\n${rule}\n  ? for shortcuts`;
    const ghostText = '\n\n  merge it\n\n';
    expect(detectAgentComposer(text, 'claude', { typedText, ghostText })).toEqual({
      isPresent: true,
      hasUndeliveredText: false,
      ghostText: 'merge it',
    });

    const typed = `${rule}\n❯ ship it\n${rule}`;
    expect(detectAgentComposer(typed, 'claude', { typedText: typed, ghostText: '' })).toEqual({ isPresent: true, hasUndeliveredText: true });
  });

  it('reads Claude\'s queued-messages hint as ghost text and ignores the queued message above the box', () => {
    const text = `❯ Reply with QUEUED\n  ctrl+x ctrl+s to send now\n${rule}\n❯ Press up to edit queued messages\n${rule}`;
    const typedText = `❯\n\n${rule}\n❯\n${rule}`;
    const ghostText = '  Reply with QUEUED\n  ctrl+x ctrl+s to send now\n\n  Press up to edit queued messages\n';
    expect(detectAgentComposer(text, 'claude', { typedText, ghostText })).toEqual({
      isPresent: true,
      hasUndeliveredText: false,
      ghostText: 'Press up to edit queued messages',
    });
  });

  it('reads any dim Codex placeholder as ghost text, and the loading header from the full screen', () => {
    const text = '│ model:     gpt │\n› Explain this codebase\n  ? for shortcuts';
    const typedText = '│            gpt │\n›\n';
    const ghostText = '│ model:         │\n  Explain this codebase\n  ? for shortcuts';
    expect(detectAgentComposer(text, 'codex', { typedText, ghostText })).toEqual({
      isPresent: true,
      hasUndeliveredText: false,
      ghostText: 'Explain this codebase',
    });
    expect(detectAgentComposer('│ model:     loading │\n› ', 'codex', { typedText: '│            loading │\n›', ghostText: '' }))
      .toEqual({ isPresent: false, hasUndeliveredText: false });
  });
});

describe('screenShowsQueuedMessage', () => {
  it('finds a message Claude queued above its composer', () => {
    const screen = `✻ Working…\n❯ Reply with the single word QUEUED\n  ctrl+x ctrl+s to send now\n${rule}\n❯ Press up to edit queued messages\n${rule}`;
    expect(screenShowsQueuedMessage(screen, 'claude', 'Reply with the single word QUEUED')).toBe(true);
    expect(screenShowsQueuedMessage(screen, 'claude', 'Something else')).toBe(false);
    // Without the queue hint, the same line is an earlier turn.
    const earlier = `❯ Reply with the single word QUEUED\n⏺ QUEUED\n${rule}\n❯\n${rule}`;
    expect(screenShowsQueuedMessage(earlier, 'claude', 'Reply with the single word QUEUED')).toBe(false);
  });

  it('finds a message Codex holds for its next turn', () => {
    const screen = '• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n'
      + '  ↳ Reply with the single word QUEUED\n› Ask Codex to do anything';
    expect(screenShowsQueuedMessage(screen, 'codex', 'Reply with the single word QUEUED\nmore lines')).toBe(true);
    expect(screenShowsQueuedMessage(screen, 'claude', 'Reply with the single word QUEUED')).toBe(false);
    expect(screenShowsQueuedMessage(screen, undefined, 'Reply with the single word QUEUED')).toBe(false);
  });
});

// Bottoms of real screens: Claude Code 2.1.301 and Codex 0.163.0, captured in tmux at 120 columns.
const claudeRule = '────────────────────────────────────────────────────────────';
const claudeIdle = (footer: string[]) => [
  '⏺ STARTED',
  '',
  '✻ Crunched for 4s · done 11:08 AM · 1 shell still running',
  '',
  claudeRule,
  '❯ wait for the background sleep to finish',
  claudeRule,
  '   Model: Haiku 5.5  Ctx: 55.4k (5%)  rr-repo  ● main',
  ...footer,
].join('\n');
const codexIdle = (aboveprompt: string[]) => [
  '• STARTED2',
  '',
  '  Worked for 4s • 11:22 AM',
  ...aboveprompt,
  '',
  '› Ask Codex to do anything',
  '',
  '  GPT-6.1-Sol default · ~/repo',
  '  ← for agents · ? for shortcuts                                         ⚠ 1 warning · f2 to view',
].join('\n');

describe('detectAgentBackgroundWork', () => {
  it('reads running background shells from the Claude footer', () => {
    expect(detectAgentBackgroundWork(claudeIdle(['  ⏵⏵ bypass permissions on · 1 shell · ← 1 agent']), 'claude')).toBe('1 shell');
    expect(detectAgentBackgroundWork(claudeIdle(['  ? for shortcuts · 3 shells']), 'claude')).toBe('3 shells');
  });

  it('reads a running background subagent listed under the Claude footer', () => {
    const screen = claudeIdle([
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent',
      '  ⏺ main',
      '  ◯ general-purpose  Count lines in /usr/share/dict files                  14s · ↓ 35.4k tokens',
    ]);
    expect(detectAgentBackgroundWork(screen, 'claude')).toBe('background agent general-purpose');
  });

  it('sees nothing once Claude\'s background work has ended, whatever the transcript above says', () => {
    expect(detectAgentBackgroundWork(claudeIdle(['  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent']), 'claude')).toBeUndefined();
    expect(detectAgentBackgroundWork(claudeIdle(['  ⏵⏵ bypass permissions on (shift+tab to cycle) · /tasks to see subagents · ← 1 agent']), 'claude')).toBeUndefined();
  });

  it('reads Codex background terminals above its prompt', () => {
    expect(detectAgentBackgroundWork(codexIdle(['  1 background terminal running · /ps to view · /stop to close']), 'codex')).toBe('1 background terminal running');
    expect(detectAgentBackgroundWork(codexIdle([]), 'codex')).toBeUndefined();
  });

  it('ignores agents it cannot read and a footer from the wrong agent', () => {
    expect(detectAgentBackgroundWork(claudeIdle(['  · 1 shell']), 'cursor')).toBeUndefined();
    expect(detectAgentBackgroundWork(codexIdle(['  1 background terminal running · /ps to view']), 'claude')).toBeUndefined();
  });
});

describe('a Claude turn that ended on an API error', () => {
  it('still identifies Claude, so a wrapper around it (agent-farm) gets agent events', () => {
    expect(detectAgentFromScreen(CLAUDE_API_ENOTFOUND_SCREEN)).toBe('claude');
    expect(detectAgentFromScreen(CLAUDE_API_SLEEP_SCREEN)).toBe('claude');
  });

  it('shows no background work, so a missing report is not held back', () => {
    expect(detectAgentBackgroundWork(CLAUDE_API_ENOTFOUND_SCREEN, 'claude')).toBeUndefined();
    expect(detectAgentBackgroundWork(CLAUDE_API_SLEEP_SCREEN, 'claude')).toBeUndefined();
  });
});
