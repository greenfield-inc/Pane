import { describe, expect, it } from 'vitest';
import { TerminalStateEmulator } from './terminalStateEmulator';
import { extractWorkspaceHeldInput, type WorkspaceHeldInputScreen } from './workspaceHeldInput';

const rule = '─'.repeat(30);
const DIM = (text: string) => `\x1b[2m${text}\x1b[22m`;
const GREY_246 = (text: string) => `\x1b[38;5;246m${text}\x1b[39m`;

/** The screen and typed layers a real emulator reads from these rows. */
async function emulatedScreen(rows: string[]): Promise<WorkspaceHeldInputScreen> {
  const emulator = new TerminalStateEmulator(60, rows.length);
  emulator.write(rows.join('\r\n'));
  await emulator.waitForIdle();
  const screen = { screenText: emulator.getScreenText(), typedText: emulator.getScreenText({ cells: 'typed' }) };
  emulator.dispose();
  return screen;
}

const claudeScreen = (composer: string) => emulatedScreen(['✻ Done', rule, `❯ ${composer}`, rule, '  ? for shortcuts']);
const codexScreen = (composer: string) => emulatedScreen(['>_ OpenAI Codex (v0.157.1)', '', `› ${composer}`, '', '  gpt-5 high']);

describe('extractWorkspaceHeldInput', () => {
  it.each([
    ['claude', 'dim', () => claudeScreen(DIM('ok, keep going'))],
    ['claude', 'grey 246', () => claudeScreen(GREY_246("how's it going?"))],
    ['codex', 'dim', () => codexScreen(DIM('ok, keep going'))],
    ['codex', 'grey 246', () => codexScreen(GREY_246("how's it going?"))],
  ])('does not read a %s %s suggestion as held input', async (agentType, _style, screen) => {
    const layers = await screen();
    expect(layers.screenText).toMatch(/ok, keep going|how's it going\?/u);
    expect(extractWorkspaceHeldInput(agentType, layers)).toBeUndefined();
  });

  it.each([
    ['claude', claudeScreen],
    ['codex', codexScreen],
  ])('returns text typed into the %s composer', async (agentType, screen) => {
    expect(extractWorkspaceHeldInput(agentType, await screen('ship it'))).toBe('ship it');
    expect(extractWorkspaceHeldInput(agentType, await screen(`ship it ${DIM('and more')}`))).toBe('ship it');
  });

  it('reads the Claude composer box of a wrapper whose agent type is not known yet', async () => {
    expect(extractWorkspaceHeldInput(undefined, await claudeScreen('ship it'))).toBe('ship it');
    expect(extractWorkspaceHeldInput(undefined, await claudeScreen(DIM('ok, keep going')))).toBeUndefined();
  });

  it('ignores an older queued message or quote above an empty Claude composer', async () => {
    const queued = await emulatedScreen([
      `\x1b[38;2;80;80;80m❯\x1b[39m please also update the docs`,
      '> quoted line from a markdown answer',
      rule,
      `❯ ${DIM('Press up to edit queued messages')}`,
      rule,
    ]);
    expect(extractWorkspaceHeldInput('claude', queued)).toBeUndefined();

    const quoted = await emulatedScreen(['> a markdown quote', rule, '❯ ', rule]);
    expect(extractWorkspaceHeldInput('claude', quoted)).toBeUndefined();
  });

  it('reads only the bottom prompt line for other agents', async () => {
    expect(extractWorkspaceHeldInput('cursor', await emulatedScreen(['> older message', 'output', '> ship it']))).toBe('ship it');
    expect(extractWorkspaceHeldInput('cursor', await emulatedScreen(['> older message', 'output', `> ${DIM('suggestion')}`]))).toBeUndefined();
    expect(extractWorkspaceHeldInput('cursor', await emulatedScreen(['> Ask Claude anything']))).toBeUndefined();
  });

  it('reports nothing without the live typed layer', () => {
    expect(extractWorkspaceHeldInput('claude', { screenText: `${rule}\n❯ ship it\n${rule}` })).toBeUndefined();
    expect(extractWorkspaceHeldInput('claude', undefined)).toBeUndefined();
  });

  it('keeps held input to 120 characters', async () => {
    expect(extractWorkspaceHeldInput('claude', { typedText: `${rule}\n❯ ${'x'.repeat(200)}\n${rule}` })).toBe('x'.repeat(120));
  });
});
