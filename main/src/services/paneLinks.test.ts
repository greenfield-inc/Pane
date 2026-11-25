import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { PaneDaemonServer } from '../daemon/server';
import type { PaneLinkNavigation } from '../../../shared/types/paneLinks';
import { DEFAULT_AGENT_ID } from '../../../shared/agents';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../shared/types/notify';
import { NotifyQueue } from './notify/notifyQueue';
import { findLinkedRepo, forwardPaneLinkToRunningPane, MAX_LINK_PROMPT_LENGTH, OPEN_PANE_LINK_CHANNEL, registerPaneLinkHandler } from './paneLinks';

const REPOS = [
  { id: 7, name: 'app', identity: 'github.com/acme/app' },
  { id: 8, name: 'site', identity: 'github.com/acme/site' },
  { id: 9, name: 'site-fork', identity: 'github.com/someone/site' },
  { id: 10, name: 'scratch', identity: null },
];

function setup(options: { confirm?: boolean; answer?: () => Promise<boolean>; createResult?: PaneCommandValue } = {}) {
  const registry = new PaneCommandRegistry();
  const created: PaneCommandValue[] = [];
  const confirmed: Array<{ repoName: string; agentLabel: string; prompt: string }> = [];
  const errors: string[] = [];
  registry.register('runpane:panes:create', (request: PaneCommandValue) => {
    created.push(request);
    return options.createResult ?? { ok: true, items: [{ ok: true, index: 0, sessionId: 'pane-new', panelId: 'panel-new' }] };
  });
  const focused: PaneCommandValue[] = [];
  const navigated: PaneLinkNavigation[] = [];
  const shown: string[] = [];
  const pairLinks: string[] = [];
  const notify = new NotifyQueue({ settings: () => DEFAULT_NOTIFY_SETTINGS, showOutsideSupported: true, shortcutRegistered: () => true, instructionFiles: () => [] });
  registry.register('runpane:panes:focus', (request: PaneCommandValue) => {
    focused.push(request);
    return { ok: true };
  });
  registerPaneLinkHandler(registry, {
    repoExists: (repoId) => repoId === 7,
    listRepos: async () => REPOS,
    confirmStart: async (request) => {
      confirmed.push(request);
      return options.answer ? options.answer() : options.confirm ?? true;
    },
    showError: (message) => { errors.push(message); },
    navigate: (target) => { navigated.push(target); },
    showWaitingCard: (paneId, panelId) => {
      const itemId = notify.waitingCardFrom(paneId, panelId);
      if (itemId) shown.push(itemId);
    },
    openPairLink: (link) => { pairLinks.push(link); },
  });
  const open = (link: PaneCommandValue) => registry.invoke(OPEN_PANE_LINK_CHANNEL, [link]);
  const ask = (source: { paneId: string; panelId: string }, title: string) => {
    void notify.ask({ question: { ui: 'approve', title }, source: { ...source, name: 'auth-refactor', agent: 'Claude' } });
    return notify.snapshot().items.find((item) => item.title === title)?.id;
  };
  return { focused, navigated, shown, pairLinks, open, ask, created, confirmed, errors };
}

describe('pane:// links', () => {
  it('opens a pane and panel through the panes focus path', async () => {
    const { focused, navigated, open } = setup();

    const result = await open('pane://open?pane=pane-1&panel=panel_2');

    expect(result).toEqual({ success: true, data: { opened: { kind: 'pane', paneId: 'pane-1', panelId: 'panel_2' } } });
    expect(focused).toEqual([{ paneId: 'pane-1', panelId: 'panel_2', source: 'user' }]);
    expect(navigated).toEqual([]);
  });

  it("opens the linked tab's oldest waiting question in Approvals", async () => {
    const { open, shown, ask } = setup();
    ask({ paneId: 'pane-2', panelId: 'panel_2' }, 'Another Pane asks first');
    const oldest = ask({ paneId: 'pane-1', panelId: 'panel_2' }, 'Apply migration 0042?');
    ask({ paneId: 'pane-1', panelId: 'panel_2' }, 'Ship it?');
    ask({ paneId: 'pane-1', panelId: 'panel_3' }, 'Another tab asks');

    await open('pane://open?pane=pane-1&panel=panel_2');

    expect(shown).toEqual([oldest]);
  });

  it('opens nothing when the linked tab has no waiting question', async () => {
    const { focused, open, shown, ask } = setup();
    ask({ paneId: 'pane-1', panelId: 'panel_3' }, 'Another tab asks');

    const result = await open('pane://open?pane=pane-1&panel=panel_2');
    await open('pane://open?pane=pane-1');

    expect(result).toMatchObject({ success: true });
    expect(focused).toHaveLength(2);
    expect(shown).toEqual([]);
  });

  it('navigates to a saved repository or a Session', async () => {
    const { navigated, open } = setup();

    const sessionId = '__orchestration_session_a729189d-ca54-47d8-b998-10c823d6ce9a__';
    await open('pane://open?repo=7');
    await open(`pane://open/?session=${sessionId}`);
    await open('pane://open?session=legacy-pane-chat');

    expect(navigated).toEqual([
      { kind: 'repo', repoId: 7 },
      { kind: 'session', sessionId },
      { kind: 'session', sessionId: 'legacy-pane-chat' },
    ]);
  });

  it("opens the confirm page for another computer's one-time link", async () => {
    const { focused, navigated, pairLinks, open } = setup();
    const link = 'pane://pair#s=Zm9vYmFyYmF6&c=macmacmacmacmac0&n=Mac&d=runpane.net';

    expect(await open(link)).toMatchObject({ success: true });
    expect(await open('pane://pair#c=macmacmacmacmac0&n=Mac')).toMatchObject({ success: false });

    expect(pairLinks).toEqual([link]);
    expect(focused).toEqual([]);
    expect(navigated).toEqual([]);
  });

  it.each([
    ['another scheme', 'https://open?pane=pane-1'],
    ['another action', 'pane://delete?pane=pane-1'],
    ['a path', 'pane://open/panes?pane=pane-1'],
    ['an unknown parameter', 'pane://open?pane=pane-1&archive=true'],
    ['a repeated parameter', 'pane://open?pane=a&pane=b'],
    ['two targets', 'pane://open?pane=a&repo=7'],
    ['a panel without its pane', 'pane://open?panel=p'],
    ['an id with a path separator', 'pane://open?pane=..%2Fsecrets'],
    ['a non-numeric repo', 'pane://open?repo=Pane'],
    ['credentials', 'pane://user:pw@open?pane=a'],
    ['a fragment', 'pane://open?pane=a#x'],
    ['not a string', 42],
  ])('rejects %s without touching Pane', async (_case, link) => {
    const { focused, navigated, open } = setup();

    const result = await open(link);

    expect(result).toMatchObject({ success: false });
    expect(focused).toEqual([]);
    expect(navigated).toEqual([]);
  });

  it('starts an agent on the prompt in a new Pane only after the person presses Start', async () => {
    const { open, created, confirmed, errors } = setup();
    const prompt = 'Fix the failing login test.\nThe run is at https://ci.example/run/42';

    const result = await open(`pane://new?repo=acme%2Fapp&agent=codex&prompt=${encodeURIComponent(prompt)}`);

    expect(result).toEqual({ success: true, data: { opened: { kind: 'new', repoId: 7, agent: 'codex', confirming: true } } });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(confirmed).toEqual([{ repoName: 'app', agentLabel: expect.any(String), prompt }]);
    expect(created).toEqual([{
      repo: { id: 7 },
      panes: [{ name: 'Fix the failing login test', tool: { agent: 'codex', initialInput: prompt } }],
      focus: true,
      source: 'user',
    }]);
    expect(errors).toEqual([]);
  });

  it('creates nothing when the person cancels', async () => {
    const { open, created, confirmed } = setup({ confirm: false });

    expect(await open('pane://new?repo=app&prompt=Say+hello')).toMatchObject({ success: true });

    await vi.waitFor(() => expect(confirmed).toHaveLength(1));
    // Let the handler finish after the answer, so a create after Cancel would be seen.
    await new Promise((resolve) => setImmediate(resolve));
    expect(created).toEqual([]);
  });

  it('asks about one link at a time and refuses another while a question is open', async () => {
    let answer: (start: boolean) => void = () => undefined;
    const { open, confirmed, created } = setup({ answer: () => new Promise((resolve) => { answer = resolve; }) });

    await open('pane://new?repo=app&prompt=first');
    await vi.waitFor(() => expect(confirmed).toHaveLength(1));
    const second = await open('pane://new?repo=app&prompt=second');

    expect(second).toEqual({ success: false, error: expect.stringContaining('already asking') });
    answer(true);
    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(await open('pane://new?repo=app&prompt=third')).toMatchObject({ success: true });
    expect(confirmed.map((request) => request.prompt)).toEqual(['first', 'third']);
  });

  it('shows and sends the prompt with trailing spaces and blank-line padding collapsed', async () => {
    const { open, confirmed, created } = setup();

    await open(`pane://new?repo=app&prompt=${encodeURIComponent('Summarize the README.   \n\n\n\n  \n\nThen stop.')}`);

    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(confirmed[0].prompt).toBe('Summarize the README.\n\nThen stop.');
    expect(created[0]).toMatchObject({ panes: [{ tool: { initialInput: 'Summarize the README.\n\nThen stop.' } }] });
  });

  it('names the Pane "Linked task" when the prompt has no letters a branch name can use', async () => {
    const { open, created } = setup();

    await open(`pane://new?repo=app&prompt=${encodeURIComponent('修复登录测试 🚀')}`);

    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ panes: [{ name: 'Linked task' }] });
  });

  it("uses Pane's default agent when the link names none", async () => {
    const { open, created } = setup();

    await open('pane://new?repo=7&prompt=hi');

    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ panes: [{ tool: { agent: DEFAULT_AGENT_ID } }] });
  });

  it('tells the person when the new Pane could not start', async () => {
    const { open, errors } = setup({ createResult: { ok: false, items: [{ ok: false, index: 0, error: { message: 'branch taken' } }] } });

    await open('pane://new?repo=app&prompt=hi');

    await vi.waitFor(() => expect(errors).toEqual([expect.stringContaining('branch taken')]));
  });

  it('says why when no saved repository matches, and asks nothing', async () => {
    const { open, confirmed } = setup();

    const result = await open('pane://new?repo=acme%2Fmissing&prompt=hi');

    expect(result).toEqual({ success: false, error: expect.stringContaining('No saved repository matches "acme/missing"') });
    expect(confirmed).toEqual([]);
  });

  it.each([
    ['no prompt', 'pane://new?repo=app'],
    ['a blank prompt', 'pane://new?repo=app&prompt=%20%0A'],
    ['a prompt over the cap', `pane://new?repo=app&prompt=${'x'.repeat(MAX_LINK_PROMPT_LENGTH + 1)}`],
    ['an escape sequence in the prompt', 'pane://new?repo=app&prompt=hi%1B%5B2J'],
    ['a carriage return in the prompt', 'pane://new?repo=app&prompt=a%0Db'],
    ['a bidirectional override in the prompt', 'pane://new?repo=app&prompt=a%E2%80%AEb'],
    ['a bidirectional isolate in the prompt', 'pane://new?repo=app&prompt=a%E2%81%A6b'],
    ['DEL in the prompt', 'pane://new?repo=app&prompt=a%7Fb'],
    ['a C1 control in the prompt', 'pane://new?repo=app&prompt=a%C2%85b'],
    ['a Unicode tag character in the prompt', 'pane://new?repo=app&prompt=a%F3%A0%81%81b'],
    ['a zero-width space in the prompt', 'pane://new?repo=app&prompt=a%E2%80%8Bb'],
    ['a zero-width joiner in the prompt', 'pane://new?repo=app&prompt=a%E2%80%8Db'],
    ['a left-to-right mark in the prompt', 'pane://new?repo=app&prompt=a%E2%80%8Eb'],
    ['an Arabic letter mark in the prompt', 'pane://new?repo=app&prompt=a%D8%9Cb'],
    ['a line separator in the prompt', 'pane://new?repo=app&prompt=a%E2%80%A8b'],
    ['a paragraph separator in the prompt', 'pane://new?repo=app&prompt=a%E2%80%A9b'],
    ['a byte-order mark at the start of the prompt', 'pane://new?repo=app&prompt=%EF%BB%BFhi'],
    ['a prompt that starts with a dash, which an agent would read as an option', 'pane://new?repo=app&prompt=--settings%3D%2Ftmp%2Fx'],
    ['an unknown agent', 'pane://new?repo=app&prompt=hi&agent=sh'],
    ['an unknown parameter', 'pane://new?repo=app&prompt=hi&yes=1'],
    ['a pane target', 'pane://new?pane=p&prompt=hi'],
    ['a repeated prompt', 'pane://new?repo=app&prompt=a&prompt=b'],
    ['a path as the repo', 'pane://new?repo=%2Fetc&prompt=hi'],
    ['a repo with a parent segment', 'pane://new?repo=a%2F..%2Fb&prompt=hi'],
    ['no repo', 'pane://new?prompt=hi'],
  ])('rejects a start link with %s and asks nothing', async (_case, link) => {
    const { open, confirmed, created } = setup();

    expect(await open(link)).toMatchObject({ success: false });

    expect(confirmed).toEqual([]);
    expect(created).toEqual([]);
  });

  it('tells the user what a bare pane://open link is missing', async () => {
    const { open } = setup();

    expect(await open('pane://open')).toEqual({ success: false, error: expect.stringContaining('pane://open?pane=<id>') });
  });

  it('tells the user how to find a repository that does not exist', async () => {
    const { open } = setup();

    const result = await open('pane://open?repo=8');

    expect(result).toEqual({ success: false, error: expect.stringContaining('runpane repos list') });
  });

  it('hands a link to the Pane already running for the data directory', async () => {
    const appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-links-'));
    const { focused, open } = setup();
    const registry = new PaneCommandRegistry();
    registry.register(OPEN_PANE_LINK_CHANNEL, (link: PaneCommandValue) => open(link));
    const server = new PaneDaemonServer(registry, appDirectory);
    await server.start();
    try {
      expect(await forwardPaneLinkToRunningPane('pane://open?pane=pane-9', appDirectory)).toBe(true);
      expect(focused).toEqual([{ paneId: 'pane-9', panelId: undefined, source: 'user' }]);
    } finally {
      await server.stop();
      fs.rmSync(appDirectory, { recursive: true, force: true });
    }
  });

  it('reports that no Pane is running when nothing listens', async () => {
    const appDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-links-'));
    try {
      expect(await forwardPaneLinkToRunningPane('pane://open?pane=pane-9', appDirectory, 1_000)).toBe(false);
    } finally {
      fs.rmSync(appDirectory, { recursive: true, force: true });
    }
  });
});

describe('findLinkedRepo', () => {
  it('finds a repository by id, saved name, or origin remote', () => {
    expect(findLinkedRepo(REPOS, '8').name).toBe('site');
    expect(findLinkedRepo(REPOS, 'SITE-fork').id).toBe(9);
    expect(findLinkedRepo(REPOS, 'acme/app').id).toBe(7);
    expect(findLinkedRepo(REPOS, 'Acme/Site').id).toBe(8);
    expect(findLinkedRepo(REPOS, 'github.com/someone/site').id).toBe(9);
  });

  it('refuses a name that matches part of a remote or several repositories', () => {
    expect(() => findLinkedRepo(REPOS, 'me/site')).toThrow('No saved repository matches');
    expect(() => findLinkedRepo([...REPOS, { id: 11, name: 'site-copy', identity: 'gitlab.com/acme/site' }], 'acme/site'))
      .toThrow('Several saved repositories match "acme/site"');
    expect(() => findLinkedRepo(REPOS, '99')).toThrow('No saved repository matches "99"');
  });
});
