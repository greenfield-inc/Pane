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
