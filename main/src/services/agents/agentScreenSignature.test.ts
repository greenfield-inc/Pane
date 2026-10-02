import { describe, expect, it } from 'vitest';
import { detectAgentComposer, detectAgentFromScreen, screenShowsQueuedMessage } from './agentScreenSignature';

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
