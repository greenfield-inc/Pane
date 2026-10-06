import { describe, expect, it } from 'vitest';
import { assessComposerEvidence, isSlashCommandInput, looksLikePendingComposer } from './runpaneComposerEvidence';

const stagedText = '/do TM-x';

describe('isSlashCommandInput', () => {
  it.each([
    ['/do TM-x', true],
    ['  /frobnicate x', true],
    ['\n/status\nmore', true],
    ['/', false],
    ['$discussion issue', false],
    ['ordinary prose', false],
  ])('classifies %j as %s', (input, expected) => {
    expect(isSlashCommandInput(input)).toBe(expected);
  });
});

describe('looksLikePendingComposer', () => {
  const rule = '─'.repeat(40);

  it.each([
    ['a Claude paste marker in the composer', `${rule}\n❯ [Pasted text #1 +14 lines]\n${rule}\n  ⏵⏵ bypass permissions on`, true],
    ['a Codex paste marker in the composer', '• Ran tests\n› [Pasted Content 2048 chars]\n  ctrl+enter to submit', true],
    ['the Codex Ctrl+Enter hint under the composer', '› deploy it\n  Press Ctrl+Enter to submit', true],
    ['a composer-less screen ending in a paste marker', 'loading…\n[Pasted Content +5 lines]', true],
    ['an earlier pasted turn above an empty Claude composer', `❯ [Pasted text #1 +14 lines]\n⏺ PASTED\n${rule}\n❯\n${rule}`, false],
    ['an earlier pasted turn far above a composer-less screen', '[Pasted text #2 +3 lines]\none\ntwo\nthree\nfour', false],
    ['ordinary output', 'normal output without markers\n[Some other bracket]', false],
  ])('%s → %s', (_label, text, expected) => {
    expect(looksLikePendingComposer(text)).toBe(expected);
  });
});

describe('assessComposerEvidence', () => {
  it.each(['? for shortcuts', '← for agents · ? for shortcuts'])(
    'keeps a Codex prompt staged with persistent footer %s', (hint) => {
      const screen = `› /do TM-x\n\n  GPT-6.1-Sol low fast · /tmp/qa\n  ${hint}`;
      expect(assessComposerEvidence({ beforeText: screen, afterText: screen, stagedText })).toBe('staged');
    },
  );
  const openCodeComposer = (text: string) => `  ┃\n  ┃  ${text.replaceAll('\n', '\n  ┃  ')}\n  ┃\n  ┃  Build\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀\n  shift+tab agents  ctrl+p commands`;

  it.each(['Build', 'Build\nMake a change'])('excludes metadata when verifying %j', (input) => {
    expect(assessComposerEvidence({ beforeText: openCodeComposer(input), afterText: openCodeComposer('Ask anything…'), stagedText: input, agentType: 'opencode' })).toBe('cleared');
  });

  it('does not mistake metadata for observed staged input', () => {
    const frame = openCodeComposer('Ask anything…');
    expect(assessComposerEvidence({ beforeText: frame, afterText: frame, stagedText: 'Build', agentType: 'opencode' })).toBe('unknown');
  });

  it.each(['staged', 'cleared'] as const)('recognizes a wrapped paste badge as %s', (expected) => {
    const beforeText = openCodeComposer('[Pasted ~3\nlines]');
    const afterText = expected === 'staged' ? beforeText : openCodeComposer('Ask anything…');
    expect(assessComposerEvidence({ beforeText, afterText, stagedText: 'First\nSecond\nThird', agentType: 'opencode' })).toBe(expected);
  });

  it('verifies a transparent-theme composer without the opaque bottom border', () => {
    const transparent = (input: string) => openCodeComposer(input).replace('╹▀▀▀▀▀▀▀▀▀▀▀▀', '             ');
    expect(assessComposerEvidence({ beforeText: transparent('Do this'), afterText: transparent('Ask anything…'), stagedText: 'Do this', agentType: 'opencode' })).toBe('cleared');
  });

  it.each([
    ['unchanged input', openCodeComposer('Please implement this'), openCodeComposer('Please implement this'), 'staged'],
    ['a blank redraw', openCodeComposer('Please implement this'), '', 'unknown'],
    ['no staged input observed', openCodeComposer('Ask anything…'), openCodeComposer('Ask anything…'), 'unknown'],
    ['a wrapped input line', openCodeComposer('Please implem\nent this'), openCodeComposer('Ask anything…'), 'cleared'],
  ] as const)('handles OpenCode %s conservatively', (_name, beforeText, afterText, expected) => {
    expect(assessComposerEvidence({ beforeText, afterText, stagedText: 'Please implement this', agentType: 'opencode' }))
      .toBe(expected);
  });

  it('observes an OpenCode submission with the user turn still visible in history', () => {
    const composer = (text: string) => `  ┃\n  ┃  ${text}\n  ┃\n  ┃  Build\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀\n  shift+tab agents  ctrl+p commands`;
    expect(assessComposerEvidence({
      beforeText: composer('Please implement this'),
      afterText: `  ┃  Please implement this\n\nDone.\n\n${composer('Ask anything…')}`,
      stagedText: 'Please implement this',
      agentType: 'opencode',
    })).toBe('cleared');
  });

  it('observes a submitted OpenCode paste marker without requiring the hidden text', () => {
    expect(assessComposerEvidence({
      beforeText: openCodeComposer('[Pasted ~3 lines]'),
      afterText: `First line\nSecond line\nThird line\n\n${openCodeComposer('Ask anything…')}`,
      stagedText: 'First line\nSecond line\nThird line',
      agentType: 'opencode',
    })).toBe('cleared');
  });

  const cases: Array<{
    name: string;
    beforeText: string;
    afterText: string;
    expected: ReturnType<typeof assessComposerEvidence>;
  }> = [
    {
      name: 'Codex staged input with autocomplete popup',
      beforeText: '› /do TM-x\n  /do  Run implementation workflow',
      afterText: '› /do TM-x\n  /do  Run implementation workflow',
      expected: 'staged',
    },
    {
      name: 'Codex staged input after popup closes',
      beforeText: '› /do TM-x\n  /do  Run implementation workflow',
      afterText: '› /do TM-x',
      expected: 'staged',
    },
    {
      name: 'Claude staged input row',
      beforeText: '❯ /do TM-x\n  ctrl+enter to submit',
      afterText: '❯ /do TM-x\n  ctrl+enter to submit',
      expected: 'staged',
    },
    {
      name: 'submitted input echoed in transcript with spinner',
      beforeText: '› /do TM-x',
      afterText: '› /do TM-x\nWorking (2s)\n›',
      expected: 'unknown',
    },
    {
      name: 'submitted input echoed in idle transcript',
      beforeText: '❯ /do TM-x',
      afterText: 'Human: /do TM-x\nAssistant: Done.\n❯',
      expected: 'unknown',
    },
    {
      name: 'composer cleared with no echo',
      beforeText: '› /do TM-x',
      afterText: 'Working (1s)\n›',
      expected: 'cleared',
    },
    {
      name: 'empty screen',
      beforeText: '› /do TM-x',
      afterText: '',
      expected: 'cleared',
    },
    {
      name: 'marker moved between prompt styles',
      beforeText: '› /do TM-x',
      afterText: '❯ /do TM-x',
      expected: 'unknown',
    },
  ];

  it.each(cases)('$name -> $expected', ({ beforeText, afterText, expected }) => {
    expect(assessComposerEvidence({ beforeText, afterText, stagedText })).toBe(expected);
  });

  it('returns unknown when staged text has no usable marker', () => {
    expect(assessComposerEvidence({
      beforeText: '›',
      afterText: '›',
      stagedText: ' \n ',
    })).toBe('unknown');
  });
});
