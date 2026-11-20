import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import type { PaneDaemonCaller } from '../../../shared/types/daemon';
import type { BrowserPanelState, ToolPanel } from '../../../shared/types/panels';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { BrowserPageContents } from '../services/browser/pageDriver';
import { registerBrowserHandlers, TOUCH_HOLD_MS, type BrowserHoldSettings, type BrowserHost, type BrowserServices, type TabDownload } from './browser';
import { readFileSync } from 'fs';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { decodeBoundary, type JsonObject } from '../../../shared/validation/boundaryDecoder';
import { browserFrameAnswerSchema, browserTabViewSchema } from '../../../shared/validation/browserStreamSchemas';

/** The start of a PNG of `width` by `height` pixels: its signature and IHDR chunk, which hold its size. */
function pngOf(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

/** A page that answers the page script and the debugger the way a simple form page would. */
function fakePage(id: number, url: string): BrowserPageContents & EventEmitter & { sent: string[]; files: string[]; params: Map<string, unknown>; throttled: boolean; muted: boolean } {
  const events = new EventEmitter();
  const sent: string[] = [];
  const files: string[] = [];
  const params = new Map<string, unknown>();
  let attached = false;
  const page = Object.assign(events, {
    id,
    sent,
    files,
    params,
    throttled: true,
    muted: false,
    setBackgroundThrottling: (allowed: boolean) => { page.throttled = allowed; },
    setAudioMuted: (muted: boolean) => { page.muted = muted; },
    isDestroyed: () => false,
    getURL: () => url,
    getTitle: () => 'Sign up',
    isLoading: () => false,
    isDevToolsOpened: () => false,
    devToolsWebContents: null,
    insertText: async () => undefined,
    sendInputEvent: () => undefined,
    capturePage: async () => ({ toPNG: () => Buffer.from('png'), getSize: () => ({ width: 800, height: 600 }) }),
    loadURL: async (next: string) => { url = next; },
    reload: () => undefined,
    navigationHistory: { canGoBack: () => false, goBack: () => undefined, canGoForward: () => false, goForward: () => undefined },
    executeJavaScriptInIsolatedWorld: async (_world: number, [{ code }]: { code: string }[]) => {
      const method = /\)\.(\w+)\([^()]*\)$/.exec(code)?.[1];
      if (method === 'snapshot') return { snapshot: '- textbox "Email" [ref=e1]\n- button "Sign up" [ref=e2]', truncated: false, url, title: 'Sign up' };
      if (method === 'point') return { x: 40, y: 80 };
      if (method === 'check') return { met: true };
      return true;
    },
    debugger: Object.assign(new EventEmitter(), {
      attach: () => { attached = true; },
      isAttached: () => attached,
      detach: () => { attached = false; },
      sendCommand: async (method: string, given?: { files?: string[]; expression?: string }) => {
        sent.push(method);
        params.set(method, given);
        if (method === 'DOM.setFileInputFiles') files.push(...(given?.files ?? []));
        if (method === 'Page.captureScreenshot') return { data: pngOf(780, 1688).toString('base64') };
        if (method === 'Runtime.evaluate' && JSON.stringify(given).includes('innerWidth')) return { result: { value: { width: 800, height: 600, x: 0, y: 120, ratio: 2 } } };
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { width: 800, height: 600 }, cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 7 };
        return {};
      },
    }),
  });
  return page;
}

interface Fixture {
  registry: PaneCommandRegistry;
  tabs: ToolPanel[];
  pages: Map<string, ReturnType<typeof fakePage>>;
  setTools(on: boolean): void;
  worktree: string;
  /** A page in `tabId` starts downloading `filename`; resolves with where it saved, once the file is written and done. */
  download(tabId: string, filename: string, content: string): Promise<string>;
  /** The tabs that said "Downloaded …", with the file. */
  shownDownloads: Array<[string, string]>;
  /** Archives a Pane, as Pane does: it is marked archived, then the host hears it went. */
  archive(paneId: string): void;
}

function browserTab(id: string, paneId: string, openedByPanel?: string, url = 'http://localhost:4173/'): ToolPanel {
  const customState: BrowserPanelState = { currentUrl: url };
  const tab: ToolPanel = { id, sessionId: paneId, type: 'browser', title: id, state: { isActive: true, customState }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
  if (openedByPanel) tab.metadata.openedBy = { source: 'agent', panelId: openedByPanel };
  return tab;
}

function agentTab(id: string, paneId: string, agent: string): ToolPanel {
  return { id, sessionId: paneId, type: 'terminal', title: agent, state: { isActive: false, customState: { agent } }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
}

function setup(initial: ToolPanel[] = [], options: { cursors?: string[]; held?: string[]; painting?: string[]; holds?: Partial<BrowserHoldSettings>; loading?: boolean; window?: { open: boolean } } = {}): Fixture {
  const archived = new Set<string>();
  const goneListeners: Array<() => void> = [];
  const worktree = mkdtempSync(path.join(os.tmpdir(), 'pane-browser-tools-'));
  let tools = true;
  const tabs = [agentTab('claude-a', 'pane-a', 'claude'), agentTab('codex-a', 'pane-a', 'codex'), ...initial];
  const pages = new Map<string, ReturnType<typeof fakePage>>();
  let nextPage = 1;
  let downloadListener: ((download: TabDownload) => void) | undefined;
  const shownDownloads: Array<[string, string]> = [];
  for (const tab of initial) {
    if (tab.type !== 'browser') continue;
    // SAFETY: browserTab builds every initial tab's customState as a BrowserPanelState.
    const state = tab.state.customState as BrowserPanelState | undefined;
    pages.set(tab.id, fakePage(nextPage++, state?.currentUrl ?? 'http://localhost:4173/'));
  }
  const host: BrowserHost = {
    tabs: (paneId) => tabs.filter(tab => tab.sessionId === paneId && tab.type === 'browser'),
    tab: (id) => tabs.find(tab => tab.id === id),
    open: async (paneId, url, callerPanelId) => {
      const tab = browserTab(`tab-${tabs.length}`, paneId, callerPanelId, url);
      tabs.push(tab);
      const page = fakePage(nextPage++, url);
      if (options.loading) Object.assign(page, { isLoading: () => true });
      pages.set(tab.id, page);
      return tab;
    },
    close: async (tab) => { tabs.splice(tabs.indexOf(tab), 1); },
    update: async (tab, state) => { tab.state = { ...tab.state, customState: state }; },
    page: (id) => pages.get(id),
    hasWindow: () => options.window?.open ?? true,
    shotsDirectory: async () => path.join(worktree, '.shots'),
    showCursor: (panelId) => { options.cursors?.push(panelId); },
    name: () => 'studio-mac',
    uploadsFor: async () => { const folder = path.join(worktree, '.uploads'); mkdirSync(folder, { recursive: true }); return folder; },
    sizeHidden: () => undefined,
    // As the window does: a tab whose hold ends loses its page; a newly held tab gets one.
    setHeld: (tabIds, painting) => {
      for (const id of options.held ?? []) if (!tabIds.includes(id)) pages.delete(id);
      for (const id of tabIds) {
        const tab = tabs.find(candidate => candidate.id === id);
        if (!tab || pages.has(id)) continue;
        // SAFETY: browserTab builds every tab's customState as a BrowserPanelState.
        const state = tab.state.customState as BrowserPanelState | undefined;
        pages.set(id, fakePage(nextPage++, state?.currentUrl ?? 'http://localhost:4173/'));
      }
      options.held?.splice(0, Infinity, ...tabIds);
      options.painting?.splice(0, Infinity, ...painting);
    },
    onGone: (listener) => { goneListeners.push(listener); },
    setBusy: () => undefined,
    onDownload: (listener) => { downloadListener = listener; },
    personDownloads: () => path.join(worktree, 'Downloads'),
    agentDownloads: async () => path.join(worktree, '.scratch', 'browser-downloads'),
    showDownload: (panelId, file) => { shownDownloads.push([panelId, file]); },
  };
  mkdirSync(path.join(worktree, 'Downloads'));
  const download = async (tabId: string, filename: string, content: string): Promise<string> => {
    let saveAt = '';
    let finish: (done: boolean) => void = () => undefined;
    const finished = new Promise<boolean>(resolve => { finish = resolve; });
    downloadListener?.({ pageId: pages.get(tabId)?.id ?? 0, tabId, filename, saveAs: (file) => { saveAt = file; }, finished });
    // Electron writes the file, then reports it done.
    writeFileSync(saveAt, content);
    finish(true);
    return saveAt;
  };
  const services: BrowserServices = {
    sessionManager: { getSession: (id: string) => (id === 'pane-a' || id === 'pane-b' ? { name: id, worktreePath: worktree, archived: archived.has(id) } : undefined) },
    configManager: { getConfig: () => ({ browser: { agentTools: tools } }) },
  };
  const registry = new PaneCommandRegistry();
  onTestFinished(registerBrowserHandlers(services, registry, host, options.holds));
  const archive = (paneId: string) => { archived.add(paneId); for (const listener of goneListeners) listener(); };
  return { registry, tabs, pages, setTools: (on) => { tools = on; }, worktree, download, shownDownloads, archive };
}

const signal = new AbortController().signal;
const claudeInA: PaneDaemonCaller = { paneId: 'pane-a', panelId: 'claude-a' };
const codexInA: PaneDaemonCaller = { paneId: 'pane-a', panelId: 'codex-a' };

/** `null` calls from outside any Pane tab. */
async function call(fixture: Fixture, verb: string, request: JsonObject, caller: PaneDaemonCaller | null = claudeInA): Promise<PaneCommandValue> {
  return fixture.registry.invokeConnected(`runpane:browser:${verb}`, [request], signal, caller ?? undefined);
}

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (cause) {
    return cause instanceof PaneError ? cause.code : String(cause);
  }
}

describe('browser tools: who may call', () => {
  it('refuses a call from outside any Pane tab', async () => {
    const fixture = setup([browserTab('person-tab', 'pane-a')]);
    expect(await code(call(fixture, 'tabs', {}, null))).toBe('ERR_BROWSER_NO_PANE');
    expect(await code(call(fixture, 'tabs', {}, { paneId: 'gone' }))).toBe('ERR_BROWSER_NO_PANE');
  });

  it('refuses every tool while Settings > Browser has them off', async () => {
    const fixture = setup([browserTab('person-tab', 'pane-a')]);
    fixture.setTools(false);
    for (const verb of ['tabs', 'snapshot', 'click', 'open']) {
      expect(await code(call(fixture, verb, verb === 'open' ? { url: 'http://localhost:1/' } : { ref: 'e1' }))).toBe('ERR_BROWSER_TOOLS_OFF');
    }
  });

  it('refuses a call that came from another computer', async () => {
    const fixture = setup([browserTab('person-tab', 'pane-a')]);
    expect(await code(fixture.registry.invokeRemote('runpane:browser:tabs', [{}], { caller: claudeInA }))).toBe('ERR_BROWSER_LOCAL_ONLY');
  });
});

describe('browser tools: which tabs', () => {
  it('lists only the calling Pane\'s tabs, and refuses another Pane\'s tab by id', async () => {
    const fixture = setup([browserTab('a-tab', 'pane-a'), browserTab('b-tab', 'pane-b')]);
    const listed = await call(fixture, 'tabs', {});
    expect(JSON.stringify(listed)).toContain('a-tab');
    expect(JSON.stringify(listed)).not.toContain('b-tab');
    expect(await code(call(fixture, 'snapshot', { tab: 'b-tab' }))).toBe('ERR_BROWSER_NO_TAB');
  });

  it('needs a tab id once the Pane has several tabs, and says which', async () => {
    const fixture = setup([browserTab('person-1', 'pane-a'), browserTab('person-2', 'pane-a')]);
    await expect(call(fixture, 'snapshot', {})).rejects.toMatchObject({ code: 'ERR_BROWSER_TAB_REQUIRED', next: expect.stringMatching(/person-1.*person-2/) });
    expect(await code(call(setup(), 'snapshot', {}))).toBe('ERR_BROWSER_NO_TAB');
  });

  it('acts on the agent\'s own tab when it names none, even beside the person\'s tabs', async () => {
    const fixture = setup([browserTab('person-1', 'pane-a'), browserTab('mine', 'pane-a', 'claude-a')]);
    expect(await call(fixture, 'snapshot', {})).toMatchObject({ tab: 'mine' });
  });

  it('lets another agent read a tab but not act on it, and lets both act on the person\'s tab', async () => {
    const fixture = setup([browserTab('claudes', 'pane-a', 'claude-a'), browserTab('persons', 'pane-a')]);
    expect(await call(fixture, 'snapshot', { tab: 'claudes' }, codexInA)).toMatchObject({ snapshot: expect.stringContaining('[ref=e2]') });
    expect(await code(call(fixture, 'click', { tab: 'claudes', ref: 'e2' }, codexInA))).toBe('ERR_BROWSER_NOT_YOURS');
    for (const caller of [claudeInA, codexInA]) {
      await call(fixture, 'snapshot', { tab: 'persons' }, caller);
      expect(await call(fixture, 'click', { tab: 'persons', ref: 'e2' }, caller)).toMatchObject({ ok: true, tab: 'persons' });
    }
  });

  it('closes only the agent\'s own tabs', async () => {
    const fixture = setup([browserTab('persons', 'pane-a'), browserTab('claudes', 'pane-a', 'claude-a')]);
    expect(await code(call(fixture, 'close', { tab: 'persons' }))).toBe('ERR_BROWSER_NOT_YOURS');
    expect(await call(fixture, 'close', { tab: 'claudes' })).toEqual({ ok: true, tab: 'claudes' });
    expect(fixture.tabs.some(tab => tab.id === 'claudes')).toBe(false);
  });

  it('opens a tab owned by the agent, and reuses it for the same origin', async () => {
    const fixture = setup();
    const first = await call(fixture, 'open', { url: 'http://localhost:4173/signup' });
    expect(first).toMatchObject({ ok: true, reused: false });
    const second = await call(fixture, 'open', { url: 'http://localhost:4173/dashboard' });
    expect(second).toMatchObject({ ok: true, reused: true, url: 'http://localhost:4173/dashboard' });
    expect(fixture.tabs.filter(tab => tab.type === 'browser')).toHaveLength(1);
  });
});

describe('browser tools: what an agent may load and upload', () => {
  it('loads only http and https pages', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')]);
    for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,hi']) {
      expect(await code(call(fixture, 'navigate', { url }))).toBe('ERR_BROWSER_URL_REFUSED');
      expect(await code(call(fixture, 'open', { url }))).toBe('ERR_BROWSER_URL_REFUSED');
    }
  });

  it('reads nothing on a file: page in a tab, but lets the agent load a web page there', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a', 'file:///Users/me/report.html')]);
    expect(await code(call(fixture, 'snapshot', {}))).toBe('ERR_BROWSER_URL_REFUSED');
    expect(await call(fixture, 'navigate', { url: 'http://localhost:4173/' })).toMatchObject({ ok: true, url: 'http://localhost:4173/' });
  });

  it('uploads worktree files only, and never a credential', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')]);
    writeFileSync(path.join(fixture.worktree, 'report.pdf'), 'pdf');
    writeFileSync(path.join(fixture.worktree, '.env'), 'SECRET=1');
    writeFileSync(path.join(fixture.worktree, '.npmrc'), '//registry:_authToken=1');
    mkdirSync(path.join(fixture.worktree, '.ssh'));
    writeFileSync(path.join(fixture.worktree, '.ssh', 'config'), 'Host x');
    const outside = path.join(os.tmpdir(), `pane-outside-${Date.now()}.txt`);
    writeFileSync(outside, 'x');
    symlinkSync(outside, path.join(fixture.worktree, 'escape.txt'));
    for (const file of [outside, '.env', '.ssh/config', '../etc', 'escape.txt', '.npmrc']) {
      expect(await code(call(fixture, 'upload', { ref: 'e1', paths: [file] }))).toBe('ERR_BROWSER_PATH_REFUSED');
    }
    await call(fixture, 'snapshot', {});
    expect(await call(fixture, 'upload', { ref: 'e1', paths: ['report.pdf'] })).toMatchObject({ ok: true, note: 'Set report.pdf.' });
  });
});

describe('browser tools: the person takes over', () => {
  it('makes the agent\'s next call wait while the person touches the page, then run', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')]);
    await call(fixture, 'snapshot', {});
    await call(fixture, 'click', { ref: 'e2' });
    const page = fixture.pages.get('mine');
    // The agent's chip lingers after its call; the person clicks into the page.
    await new Promise(resolve => setTimeout(resolve, 400));
    page?.emit('input-event', {}, { type: 'mouseDown' });
    await vi.waitFor(() => expect(JSON.stringify(fixture.tabs.find(tab => tab.id === 'mine')?.state.customState)).toContain('"by":"person"'));
    const started = Date.now();
    // The person's touch revoked the agent's refs.
    expect(await code(call(fixture, 'click', { ref: 'e2' }))).toBe('ERR_BROWSER_STALE_REF');
    expect(Date.now() - started).toBeGreaterThanOrEqual(TOUCH_HOLD_MS - 100);
    await call(fixture, 'snapshot', {});
    expect(await call(fixture, 'click', { ref: 'e2' })).toMatchObject({ ok: true });
  });
});

describe('browser tabs: downloads', () => {
  it('saves the person\'s download in their Downloads folder, without asking, and the tab says so', async () => {
    const fixture = setup([browserTab('persons', 'pane-a')]);
    const first = await fixture.download('persons', 'report.pdf', 'one');
    const second = await fixture.download('persons', 'report.pdf', 'two');
    expect([first, second]).toEqual([path.join(fixture.worktree, 'Downloads', 'report.pdf'), path.join(fixture.worktree, 'Downloads', 'report (2).pdf')]);
    await vi.waitFor(() => expect(fixture.shownDownloads).toEqual([['persons', first], ['persons', second]]));
    expect(JSON.stringify(await call(fixture, 'tabs', {}))).not.toContain('downloads');
  });

  it('saves a download the agent\'s click caused in the Pane\'s scratch folder, and browser_tabs lists it', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')]);
    await call(fixture, 'snapshot', {});
    await call(fixture, 'click', { ref: 'e2' });
    await fixture.download('mine', 'report.pdf', 'pdf bytes');
    const saved = path.join(fixture.worktree, '.scratch', 'browser-downloads', 'report.pdf');
    await vi.waitFor(() => expect(fixture.shownDownloads).toEqual([['mine', saved]]));
    expect(readFileSync(saved, 'utf8')).toBe('pdf bytes');
    expect(await call(fixture, 'tabs', {})).toMatchObject({ tabs: [{ id: 'mine', downloads: [saved] }] });
  });
});

describe('browser tools: opening a slow page', () => {
  it('returns once the page registered, even when it is still loading', async () => {
    const fixture = setup([], { loading: true });
    expect(await call(fixture, 'open', { url: 'http://localhost:4173/slow' })).toMatchObject({ ok: true, url: 'http://localhost:4173/slow' });
  }, 20_000);
});

describe('browser tools: tabs an agent holds (P4)', () => {
  it('holds up to four tabs per agent, putting the longest idle to sleep for a fifth', async () => {
    const held: string[] = [];
    const fixture = setup([], { held });
    const opened: string[] = [];
    for (let site = 1; site <= 4; site += 1) opened.push(JSON.parse(JSON.stringify(await call(fixture, 'open', { url: `http://site-${site}.test/` }))).tab);
    // The first tab opened is used again, a moment later, so the second is now the one idle longest.
    await new Promise(resolve => setTimeout(resolve, 10));
    await call(fixture, 'snapshot', { tab: opened[0] });
    const fifth = await call(fixture, 'open', { url: 'http://site-5.test/' });
    expect(fifth).toMatchObject({ note: expect.stringContaining(`tab ${opened[1]} went to sleep`) });
    expect(held).not.toContain(opened[1]);
    expect(held).toHaveLength(4);
    const listed = JSON.parse(JSON.stringify(await call(fixture, 'tabs', {}))).tabs;
    expect(listed.find((tab: { id: string }) => tab.id === opened[1])).toMatchObject({ held: false, asleep: true });
  });

  it('puts the held tabs to sleep at once when the agent\'s Pane is archived', async () => {
    const held: string[] = [];
    const agentTerminal: ToolPanel = { id: 'claude-a', sessionId: 'pane-a', type: 'terminal', title: 'Claude Code', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a'), agentTerminal], { held });
    await call(fixture, 'snapshot', { tab: 'mine' });
    expect(held).toEqual(['mine']);
    fixture.archive('pane-a');
    expect(held).toEqual([]);
  });

  it('puts a tab to sleep after the idle time with no agent action, and says so when the agent wakes it', async () => {
    const held: string[] = [];
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { held, holds: { limit: 4, idleMs: 600, sweepMs: 40 } });
    await call(fixture, 'snapshot', {});
    expect(held).toEqual(['mine']);
    // Several sweeps later, still inside the idle time: still held.
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(held).toEqual(['mine']);
    await vi.waitFor(() => expect(held).toEqual([]), { timeout: 3_000 });
    expect(await call(fixture, 'snapshot', {})).toMatchObject({ note: expect.stringContaining('was asleep') });
    expect(held).toEqual(['mine']);
  });

  it('forgets the hold of a tab the person closed, so it counts toward no limit', async () => {
    const held: string[] = [];
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { held, holds: { limit: 4, idleMs: 60_000, sweepMs: 40 } });
    await call(fixture, 'snapshot', {});
    expect(held).toEqual(['mine']);
    fixture.tabs.splice(fixture.tabs.findIndex(tab => tab.id === 'mine'), 1);
    await vi.waitFor(() => expect(held).toEqual([]), { timeout: 2_000 });
  });

  it('keeps an agent at four held tabs when its calls to five tabs run at once', async () => {
    const held: string[] = [];
    const tabs = [1, 2, 3, 4, 5].map(n => browserTab(`t${n}`, 'pane-a', 'claude-a', `http://site-${n}.test/`));
    const fixture = setup(tabs, { held });
    await Promise.all(tabs.map(tab => call(fixture, 'snapshot', { tab: tab.id })));
    expect(held).toHaveLength(4);
  });

  it('says a tab was asleep only when its page really went away', async () => {
    const held: string[] = [];
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { held, holds: { limit: 4, idleMs: 100, sweepMs: 40 } });
    await call(fixture, 'snapshot', {});
    await vi.waitFor(() => expect(held).toEqual([]), { timeout: 2_000 });
    // The person selected the tab meanwhile, so its page is back.
    fixture.pages.set('mine', fakePage(50, 'http://localhost:4173/'));
    const listed = JSON.parse(JSON.stringify(await call(fixture, 'tabs', {}))).tabs;
    expect(listed[0]).toMatchObject({ asleep: false });
    expect(JSON.parse(JSON.stringify(await call(fixture, 'snapshot', {}))).note ?? '').not.toContain('was asleep');
  });
});

describe('browser tabs: the screens that watch them', () => {
  const holds: BrowserHoldSettings = { limit: 4, idleMs: 60_000, sweepMs: 40, watch: { limit: 2, graceMs: 300, silentMs: 150 } };
  const phone = { kind: 'phone', onScreen: true, width: 390, height: 844, scale: 3 };
  /** A screen on another device (the phone, another desktop) reports over the host channel. */
  const fromAfar = (fixture: Fixture, tab: string, viewer: string, report: JsonObject | null) => fixture.registry.invokeRemote('browser:watch', [tab, viewer, report], { caller: undefined });
  /** This computer's own window reports over local IPC. */
  const fromHere = (fixture: Fixture, tab: string, report: JsonObject | null) => fixture.registry.invoke('browser:watch', [tab, 'host-window', report]);
  type Listed = { asleep?: boolean; watching?: string[]; size?: { width: number; height: number; mobile: boolean } };
  // SAFETY: browser_tabs answers { ok, tabs } with one browserTab object per tab.
  const listed = async (fixture: Fixture) => JSON.parse(JSON.stringify(await call(fixture, 'tabs', {}))).tabs as Listed[];

  it('keeps a page alive while a screen shows it and for the grace time after it leaves, then sleeps it', async () => {
    const held: string[] = [];
    const fixture = setup([browserTab('persons', 'pane-a')], { held, holds });
    await fromAfar(fixture, 'persons', 'phone-1', phone);
    expect(held).toEqual(['persons']);
    await fromAfar(fixture, 'persons', 'phone-1', null);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(held).toEqual(['persons']);
    await vi.waitFor(() => expect(held).toEqual([]), { timeout: 2_000 });
    expect((await listed(fixture))[0]).toMatchObject({ asleep: true, watching: [] });
  });

  it('counts a screen that stopped reporting as gone', async () => {
    const held: string[] = [];
    const fixture = setup([browserTab('persons', 'pane-a')], { held, holds });
    await fromAfar(fixture, 'persons', 'phone-1', phone);
    expect((await listed(fixture))[0]).toMatchObject({ watching: ['phone'] });
    await vi.waitFor(() => expect(held).toEqual([]), { timeout: 2_000 });
  });

  it('keeps at most the limit of watched pages, sleeping the one longest off screen, and agent holds do not count', async () => {
    const held: string[] = [];
    const fixture = setup(['t1', 't2', 't3'].map(id => browserTab(id, 'pane-a')).concat(browserTab('mine', 'pane-a', 'claude-a')), { held, holds });
    await call(fixture, 'snapshot', { tab: 'mine' });
    await fromAfar(fixture, 't1', 'phone-1', phone);
    await fromAfar(fixture, 't1', 'phone-1', { ...phone, onScreen: false });
    await fromAfar(fixture, 't2', 'phone-1', phone);
    await fromAfar(fixture, 'mine', 'phone-1', phone);
    expect([...held].sort()).toEqual(['mine', 't1', 't2']);
    await fromAfar(fixture, 't3', 'phone-1', phone);
    expect([...held].sort()).toEqual(['mine', 't2', 't3']);
  });

  it('gives the page the size of the screen that took control; agent calls keep it, and the person here gives it back', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { holds: { ...holds, watch: { ...holds.watch, silentMs: 60_000 } } });
    const page = fixture.pages.get('mine');
    await fromHere(fixture, 'mine', { kind: 'desktop', onScreen: true, width: 1200, height: 700 });
    await fromAfar(fixture, 'mine', 'phone-1', phone);
    // Watching alone never resizes the page.
    expect(page?.sent).not.toContain('Emulation.setDeviceMetricsOverride');
    expect(await fixture.registry.invokeRemote('browser:driver', ['mine', 'person', 'phone-1'], { caller: undefined })).toEqual({ success: true });
    // A phone's own pixel ratio, so the page is sharp on its screen.
    await vi.waitFor(() => expect(page?.params.get('Emulation.setDeviceMetricsOverride')).toMatchObject({ width: 390, height: 844, mobile: true, deviceScaleFactor: 3 }));
    const [shown] = await listed(fixture);
    expect(shown).toMatchObject({ size: { width: 390, height: 844, mobile: true }, watching: ['host', 'phone'] });
    // Results carry only what the published output schema allows (MCP clients reject the rest).
    expect(Object.keys(shown).filter(key => !(key in RUNPANE_CONTRACT.jsonSchemas.browserTab.properties))).toEqual([]);
    await fixture.registry.invokeRemote('browser:driver', ['mine', 'agent', 'phone-1'], { caller: undefined });
    await call(fixture, 'snapshot', {});
    await call(fixture, 'click', { ref: 'e2' });
    // A 390x844 page captured at the host's 2x scale: the result names the PNG's own size.
    expect(await call(fixture, 'screenshot', {})).toMatchObject({ width: 780, height: 1688 });
    expect(page?.sent).not.toContain('Emulation.clearDeviceMetricsOverride');
    // The person at this computer clicks into the tab.
    await new Promise(resolve => setTimeout(resolve, 400));
    page?.emit('input-event', {}, { type: 'mouseDown' });
    await vi.waitFor(() => expect(page?.sent).toContain('Emulation.clearDeviceMetricsOverride'));
    expect((await listed(fixture))[0].size).toBeUndefined();
  });

  it('keeps the page at the size of the screen in control as that screen changes size', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { holds: { ...holds, watch: { ...holds.watch, silentMs: 60_000 } } });
    const page = fixture.pages.get('mine');
    await fromAfar(fixture, 'mine', 'phone-1', phone);
    await fixture.registry.invokeRemote('browser:driver', ['mine', 'person', 'phone-1'], { caller: undefined });
    await vi.waitFor(() => expect(page?.params.get('Emulation.setDeviceMetricsOverride')).toMatchObject({ width: 390, height: 844 }));
    // Another screen resizing changes nothing; the one in control resizing moves the page with it.
    await fromAfar(fixture, 'mine', 'desktop-1', { kind: 'desktop', onScreen: true, width: 1000, height: 700 });
    await fromAfar(fixture, 'mine', 'phone-1', { ...phone, height: 600 });
    await vi.waitFor(() => expect(page?.params.get('Emulation.setDeviceMetricsOverride')).toMatchObject({ width: 390, height: 600 }));
    expect((await listed(fixture))[0].size).toEqual({ width: 390, height: 600, mobile: true });
  });

  it('runs a page only another device shows unthrottled and silent here, with sound back while this window shows it', async () => {
    const painting: string[] = [];
    const fixture = setup([browserTab('persons', 'pane-a')], { painting, holds: { ...holds, watch: { ...holds.watch, silentMs: 60_000 } } });
    const page = fixture.pages.get('persons');
    await fromAfar(fixture, 'persons', 'phone-1', phone);
    expect(page).toMatchObject({ throttled: false, muted: true });
    expect(painting).toEqual(['persons']);
    await fromHere(fixture, 'persons', { kind: 'desktop', onScreen: true, width: 1200, height: 700 });
    expect(page).toMatchObject({ throttled: false, muted: false });
    await fromAfar(fixture, 'persons', 'phone-1', null);
    await vi.waitFor(() => expect(page).toMatchObject({ throttled: true, muted: false }));
  });

  it('keeps a page painting for a phone that joins a tab this computer\'s window already shows', async () => {
    const painting: string[] = [];
    const fixture = setup([browserTab('persons', 'pane-a')], { painting, holds: { ...holds, watch: { ...holds.watch, silentMs: 60_000 } } });
    await fromHere(fixture, 'persons', { kind: 'desktop', onScreen: true, width: 1200, height: 700 });
    expect(painting).toEqual([]);
    await fromAfar(fixture, 'persons', 'phone-1', phone);
    expect(painting).toEqual(['persons']);
    await fromAfar(fixture, 'persons', 'phone-1', null);
    expect(painting).toEqual([]);
  });

  it('lets a screen that has the tab off screen neither keep the page running here nor hold it past the grace time', async () => {
    const held: string[] = [];
    const fixture = setup([browserTab('persons', 'pane-a')], { held, holds });
    const page = fixture.pages.get('persons');
    await fromAfar(fixture, 'persons', 'phone-1', phone);
    expect(page).toMatchObject({ throttled: false });
    // The phone's app goes to the background but keeps reporting, off screen.
    const keepReporting = setInterval(() => void fromAfar(fixture, 'persons', 'phone-1', { ...phone, onScreen: false }), 50);
    onTestFinished(() => clearInterval(keepReporting));
    await vi.waitFor(() => expect(page).toMatchObject({ throttled: true }));
    await vi.waitFor(() => expect(held).toEqual([]), { timeout: 2_000 });
  });

  it('paints the page again when a screen comes back to a tab it had off screen', async () => {
    const painting: string[] = [];
    const fixture = setup([browserTab('persons', 'pane-a')], { painting, holds: { ...holds, watch: { ...holds.watch, silentMs: 60_000, graceMs: 60_000 } } });
    await fromAfar(fixture, 'persons', 'web-1', phone);
    expect(painting).toEqual(['persons']);
    await fromAfar(fixture, 'persons', 'web-1', { ...phone, onScreen: false });
    expect(painting).toEqual([]);
    await fromAfar(fixture, 'persons', 'web-1', phone);
    expect(painting).toEqual(['persons']);
    expect(fixture.pages.get('persons')).toMatchObject({ throttled: false });
  });

  it('lets the tabs only this window showed go when it closes, and keeps those another device watches', async () => {
    const held: string[] = [];
    const window = { open: true };
    const fixture = setup([browserTab('mine', 'pane-a'), browserTab('streamed', 'pane-a')], { held, window, holds: { ...holds, watch: { ...holds.watch, silentMs: 60_000, graceMs: 60_000 } } });
    await fromHere(fixture, 'mine', { kind: 'desktop', onScreen: true, width: 1200, height: 700 });
    await fromHere(fixture, 'streamed', { kind: 'desktop', onScreen: false, width: 1200, height: 700 });
    await fromAfar(fixture, 'streamed', 'phone-1', phone);
    expect([...held].sort()).toEqual(['mine', 'streamed']);
    window.open = false;
    await vi.waitFor(() => expect(held).toEqual(['streamed']));
  });

  it('lets a watched tab go at once when its Pane is archived', async () => {
    const held: string[] = [];
    const fixture = setup([browserTab('persons', 'pane-a')], { held, holds: { ...holds, watch: { ...holds.watch, silentMs: 60_000, graceMs: 60_000 } } });
    await fromAfar(fixture, 'persons', 'phone-1', phone);
    expect(held).toEqual(['persons']);
    fixture.archive('pane-a');
    expect(held).toEqual([]);
  });

  it('takes reports only from Pane\'s own screens, never from an agent', async () => {
    const fixture = setup([browserTab('persons', 'pane-a')]);
    expect(await fixture.registry.invokeConnected('browser:watch', ['persons', 'v', phone], signal, claudeInA)).toMatchObject({ success: false });
  });
});

describe('browser tabs: streaming a page to another screen', () => {
  const holds: BrowserHoldSettings = { limit: 4, idleMs: 60_000, sweepMs: 40, watch: { limit: 8, graceMs: 60_000, silentMs: 60_000 } };
  const phone = { kind: 'phone', onScreen: true, width: 390, height: 844, scale: 3 };
  type FrameAnswer = { frame?: { seq: number; data: string; width: number }; unchanged?: boolean; seq?: number; stopped?: string };
  // SAFETY: browser:frame answers a BrowserFrameAnswer.
  const frame = async (fixture: Fixture, tab: string, after: number) => (await fixture.registry.invokeRemote('browser:frame', [tab, 'phone-1', after], { caller: undefined })) as FrameAnswer;
  const input = (fixture: Fixture, tab: string, batch: JsonObject[]) => fixture.registry.invokeRemote('browser:input', [tab, 'phone-1', batch], { caller: undefined });
  /** Chromium paints: the screencast sends a frame. */
  const paint = (fixture: Fixture, tab: string, data: string) => fixture.pages.get(tab)?.debugger.emit('message', {}, 'Page.screencastFrame', { data, sessionId: 1, metadata: { deviceWidth: 390, deviceHeight: 844 } });

  it('starts a new screen with a still, then waits on the host for the next frame, or answers unchanged', async () => {
    const fixture = setup([browserTab('persons', 'pane-a')], { holds });
    await fixture.registry.invokeRemote('browser:watch', ['persons', 'phone-1', phone], { caller: undefined });
    const first = await frame(fixture, 'persons', 0);
    expect(decodeBoundary(first, browserFrameAnswerSchema)).toEqual(first);
    expect(first.frame).toMatchObject({ data: `data:image/jpeg;base64,${pngOf(780, 1688).toString('base64')}`, width: 800 });
    const page = fixture.pages.get('persons');
    expect(page?.params.get('Page.startScreencast')).toMatchObject({ format: 'jpeg', maxWidth: 1170, maxHeight: 2532 });
    const seq = first.frame?.seq ?? 0;
    // A still page sends nothing: the read waits about a second, then says so.
    const started = Date.now();
    expect(await frame(fixture, 'persons', seq)).toEqual({ unchanged: true, seq });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    // A paint during the wait answers at once with the new frame, and acks it so Chromium paints on.
    const waiting = frame(fixture, 'persons', seq);
    setTimeout(() => paint(fixture, 'persons', 'bmV3'), 100);
    expect((await waiting).frame).toMatchObject({ data: 'data:image/jpeg;base64,bmV3', width: 390 });
    expect(page?.sent).toContain('Page.screencastFrameAck');
  });

  it('gives a screen that holds a frame number from before a host restart the newest frame at once', async () => {
    const fixture = setup([browserTab('persons', 'pane-a')], { holds });
    await fixture.registry.invokeRemote('browser:watch', ['persons', 'phone-1', phone], { caller: undefined });
    const first = await frame(fixture, 'persons', 0);
    const started = Date.now();
    const again = await frame(fixture, 'persons', (first.frame?.seq ?? 0) + 1_000_000_000);
    expect(again.frame?.seq).toBe(first.frame?.seq);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('captures a new screen\'s still no larger than the frames, where the page is scrolled to', async () => {
    const fixture = setup([browserTab('persons', 'pane-a')], { holds });
    await fixture.registry.invokeRemote('browser:watch', ['persons', 'phone-1', phone], { caller: undefined });
    await frame(fixture, 'persons', 0);
    // An 800x600 page at 2x is 1600 px wide; the phone needs 1170.
    expect(fixture.pages.get('persons')?.params.get('Page.captureScreenshot')).toMatchObject({ format: 'jpeg', clip: { x: 0, y: 120, width: 800, height: 600, scale: 1170 / 1600 } });
  });

  it('refuses the screen channels to agents', async () => {
    const fixture = setup([browserTab('persons', 'pane-a')], { holds });
    for (const channel of ['browser:frame', 'browser:view']) {
      expect(await code(fixture.registry.invokeConnected(channel, ['persons', 'v', 0], signal, claudeInA))).toBe('ERR_BROWSER_SCREENS_ONLY');
    }
    expect(await fixture.registry.invokeConnected('browser:input', ['persons', 'v', []], signal, claudeInA)).toMatchObject({ success: false });
  });

  it('acks each frame a screen reads, so Chromium keeps painting between reads', async () => {
    const fixture = setup([browserTab('persons', 'pane-a')], { holds });
    await fixture.registry.invokeRemote('browser:watch', ['persons', 'phone-1', phone], { caller: undefined });
    let seq = (await frame(fixture, 'persons', 0)).frame?.seq ?? 0;
    const acks = () => (fixture.pages.get('persons')?.sent ?? []).filter(method => method === 'Page.screencastFrameAck').length;
    // Each frame paints while no read waits; the next read takes it and acks it.
    for (const data of ['b25l', 'dHdv']) {
      paint(fixture, 'persons', data);
      const read = await frame(fixture, 'persons', seq);
      expect(read.frame?.data).toBe(`data:image/jpeg;base64,${data}`);
      seq = read.frame?.seq ?? seq;
    }
    expect(acks()).toBe(2);
  });

  it('sends a fresh still after the page loads, when the screencast stays quiet', async () => {
    const fixture = setup([browserTab('persons', 'pane-a')], { holds });
    await fixture.registry.invokeRemote('browser:watch', ['persons', 'phone-1', phone], { caller: undefined });
    const seq = (await frame(fixture, 'persons', 0)).frame?.seq ?? 0;
    const waiting = frame(fixture, 'persons', seq);
    fixture.pages.get('persons')?.emit('did-stop-loading');
    expect((await waiting).frame?.seq).toBeGreaterThan(seq);
  });

  it('pauses the screencast while an agent takes a screenshot, never capturing twice at once', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { holds });
    await fixture.registry.invokeRemote('browser:watch', ['mine', 'phone-1', phone], { caller: undefined });
    await frame(fixture, 'mine', 0);
    const page = fixture.pages.get('mine');
    page?.sent.splice(0, Infinity);
    // The agent's screenshot uses the page's own capture once the size is set.
    await fixture.registry.invokeRemote('browser:driver', ['mine', 'person', 'phone-1'], { caller: undefined });
    await fixture.registry.invokeRemote('browser:driver', ['mine', 'agent', 'phone-1'], { caller: undefined });
    await call(fixture, 'screenshot', {});
    const sent = page?.sent ?? [];
    const shot = sent.lastIndexOf('Page.captureScreenshot');
    expect(sent.lastIndexOf('Page.stopScreencast')).toBeLessThan(shot);
    expect(sent.lastIndexOf('Page.startScreencast')).toBeGreaterThan(shot);
  });

  it('applies a screen\'s input in order, as the person\'s: the agent waits and its refs go stale', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { holds });
    await fixture.registry.invokeRemote('browser:watch', ['mine', 'phone-1', phone], { caller: undefined });
    await call(fixture, 'snapshot', {});
    await call(fixture, 'click', { ref: 'e2' });
    const page = fixture.pages.get('mine');
    page?.sent.splice(0, Infinity);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(await input(fixture, 'mine', [
      { kind: 'touch', action: 'start', x: 10, y: 20 },
      { kind: 'touch', action: 'end', x: 10, y: 20 },
      { kind: 'wheel', x: 10, y: 20, dx: 0, dy: 300 },
    ])).toMatchObject({ success: true });
    const sent = page?.sent ?? [];
    const inputs = sent.filter(method => method.startsWith('Input.'));
    expect(inputs).toEqual(['Input.dispatchTouchEvent', 'Input.dispatchTouchEvent', 'Input.dispatchMouseEvent']);
    // The page keeps its focus (a typeahead list stays open), and takes the screen's size only after the input landed.
    expect(page?.params.get('Emulation.setFocusEmulationEnabled')).toEqual({ enabled: true });
    expect(sent.indexOf('Emulation.setDeviceMetricsOverride')).toBeGreaterThan(sent.lastIndexOf('Input.dispatchMouseEvent'));
    expect(JSON.stringify(fixture.tabs.find(tab => tab.id === 'mine')?.state.customState)).toContain('"by":"person"');
    // Taking control gave the page the phone's size.
    expect(page?.params.get('Emulation.setDeviceMetricsOverride')).toMatchObject({ width: 390, height: 844, mobile: true });
    const started = Date.now();
    expect(await code(call(fixture, 'click', { ref: 'e2' }))).toBe('ERR_BROWSER_STALE_REF');
    expect(Date.now() - started).toBeGreaterThanOrEqual(TOUCH_HOLD_MS - 300);
  });

  it('answers a page\'s dialog from a screen with the browser-side command alone, as the page stays blocked until then', async () => {
    const fixture = setup([browserTab('persons', 'pane-a')], { holds });
    await fixture.registry.invokeRemote('browser:watch', ['persons', 'phone-1', phone], { caller: undefined });
    await fixture.registry.invokeRemote('browser:view', ['persons', 0], { caller: undefined });
    const page = fixture.pages.get('persons');
    page?.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete it?' });
    page?.sent.splice(0, Infinity);
    expect(await input(fixture, 'persons', [{ kind: 'dialog', accept: true }])).toMatchObject({ field: null });
    expect(page?.sent).toEqual(['Page.handleJavaScriptDialog']);
    expect(page?.params.get('Page.handleJavaScriptDialog')).toEqual({ accept: true });
  });

  it('sizes the page to the screen whose click takes control, and follows that screen as it resizes', async () => {
    const fixture = setup([browserTab('persons', 'pane-a')], { holds: { ...holds, watch: { ...holds.watch, silentMs: 60_000 } } });
    const page = fixture.pages.get('persons');
    const desktop = { kind: 'desktop', onScreen: true, width: 344, height: 748, scale: 2 };
    await fixture.registry.invokeRemote('browser:watch', ['persons', 'phone-1', desktop], { caller: undefined });
    await input(fixture, 'persons', [{ kind: 'mouse', action: 'down', x: 5, y: 5, button: 'left', clicks: 1, modifiers: 0 }, { kind: 'mouse', action: 'up', x: 5, y: 5, button: 'left', clicks: 1, modifiers: 0 }]);
    expect(page?.params.get('Emulation.setDeviceMetricsOverride')).toMatchObject({ width: 344, height: 748, mobile: false });
    // The viewer's sidebar closes: its box grows, and the page grows with it.
    await fixture.registry.invokeRemote('browser:watch', ['persons', 'phone-1', { ...desktop, width: 524 }], { caller: undefined });
    await vi.waitFor(() => expect(page?.params.get('Emulation.setDeviceMetricsOverride')).toMatchObject({ width: 524, height: 748 }));
  });

  it('moves the pointer over the page on the read channel, taking nothing over and waking no state read', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { holds });
    await call(fixture, 'snapshot', {});
    await call(fixture, 'click', { ref: 'e2' });
    const page = fixture.pages.get('mine');
    page?.sent.splice(0, Infinity);
    // SAFETY: browser:view answers a BrowserTabView.
    const before = (await fixture.registry.invokeRemote('browser:view', ['mine', 0], { caller: undefined })) as { version: number };
    expect(await fixture.registry.invokeRemote('browser:pointer', ['mine', 'phone-1', 12, 34], { caller: undefined })).toBeNull();
    expect(page?.params.get('Input.dispatchMouseEvent')).toEqual({ type: 'mouseMoved', x: 12, y: 34, button: 'none' });
    expect(JSON.stringify(fixture.tabs.find(tab => tab.id === 'mine')?.state.customState)).not.toContain('"by":"person"');
    // SAFETY: browser:view answers a BrowserTabView.
    expect(((await fixture.registry.invokeRemote('browser:view', ['mine', 0], { caller: undefined })) as { version: number }).version).toBe(before.version);
  });

  it('lets a pointer pass over the stream without taking the page from the agent', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { holds });
    await fixture.registry.invokeRemote('browser:watch', ['mine', 'phone-1', phone], { caller: undefined });
    await call(fixture, 'snapshot', {});
    await call(fixture, 'click', { ref: 'e2' });
    await input(fixture, 'mine', [{ kind: 'mouse', action: 'move', x: 5, y: 5, button: 'none', clicks: 0, modifiers: 0 }]);
    expect(JSON.stringify(fixture.tabs.find(tab => tab.id === 'mine')?.state.customState)).not.toContain('"by":"person"');
    expect(fixture.pages.get('mine')?.sent).not.toContain('Emulation.setDeviceMetricsOverride');
    expect(await call(fixture, 'click', { ref: 'e2' })).toMatchObject({ ok: true });
  });

  it('gives the screen the tab\'s state, and wakes a waiting read when it changes', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { holds });
    // SAFETY: browser:view answers a BrowserTabView.
    const first = (await fixture.registry.invokeRemote('browser:view', ['mine', 0], { caller: undefined })) as { version: number; url: string; host: string };
    expect(first).toMatchObject({ url: 'http://localhost:4173/', host: 'studio-mac' });
    const started = Date.now();
    const waiting = fixture.registry.invokeRemote('browser:view', ['mine', first.version], { caller: undefined });
    await call(fixture, 'snapshot', {});
    await call(fixture, 'click', { ref: 'e2' });
    expect(await waiting).toMatchObject({ version: expect.any(Number) });
    expect(Date.now() - started).toBeLessThan(5_000);
    // What screens decode (shared/validation/browserStreamSchemas.ts) is what the host sends.
    expect(decodeBoundary(await fixture.registry.invokeRemote('browser:view', ['mine', 0], { caller: undefined }), browserTabViewSchema)).toMatchObject({ driver: { by: 'agent' }, agentCursor: { x: 40, y: 80 } });
    expect(decodeBoundary(await fixture.registry.invokeRemote('browser:view', ['closed', 0], { caller: undefined }), browserTabViewSchema)).toMatchObject({ stopped: 'gone' });
  });

  it('says a tab is asleep, so the screen offers to wake it', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { held: [], holds: { ...holds, idleMs: 50 } });
    await call(fixture, 'snapshot', {});
    await vi.waitFor(() => expect(fixture.pages.has('mine')).toBe(false), { timeout: 2_000 });
    expect(await frame(fixture, 'mine', 0)).toEqual({ stopped: 'asleep' });
  });
});

describe('browser tools: every call answers by a deadline', () => {
  it('fails a screenshot of a page that gives no picture (a minimized window) quickly, saying why', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { holds: { screenshotMs: 200 } });
    const page = fixture.pages.get('mine');
    const paints = page?.capturePage;
    Object.assign(page ?? {}, { capturePage: () => new Promise(() => undefined) });
    const started = Date.now();
    await expect(call(fixture, 'screenshot', {})).rejects.toMatchObject({ code: 'ERR_BROWSER_SCREENSHOT_TIMEOUT', message: expect.stringContaining('minimized or covered') });
    expect(Date.now() - started).toBeLessThan(2_000);
    // Other calls go on, and once the window is back the next screenshot isn't stuck behind the lost one.
    expect(await call(fixture, 'snapshot', {})).toMatchObject({ ok: true });
    Object.assign(page ?? {}, { capturePage: paints });
    expect(await call(fixture, 'screenshot', {})).toMatchObject({ ok: true, mimeType: 'image/png' });
  });

  it('fails any other call that stops answering, saying it may still finish', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')], { holds: { callMs: 200 } });
    Object.assign(fixture.pages.get('mine') ?? {}, { executeJavaScriptInIsolatedWorld: () => new Promise(() => undefined) });
    await expect(call(fixture, 'snapshot', {})).rejects.toMatchObject({ code: 'ERR_BROWSER_CALL_TIMEOUT' });
  });
});

describe('browser tools: a dialog open on the page', () => {
  it('refuses a screenshot at once instead of waiting on the blocked page', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')]);
    await call(fixture, 'snapshot', {});
    fixture.pages.get('mine')?.debugger.emit('message', {}, 'Page.javascriptDialogOpening', { type: 'alert', message: 'Saved' });
    await expect(call(fixture, 'screenshot', {})).rejects.toMatchObject({ code: 'ERR_BROWSER_DIALOG_PENDING', message: expect.stringContaining('an alert dialog') });
  });
});

describe('browser tools: Take over pressed during a call', () => {
  it('keeps the person driving after the call ends, shows it, and holds the agent\'s next call until Hand to', async () => {
    const fixture = setup([browserTab('mine', 'pane-a', 'claude-a')]);
    const page = fixture.pages.get('mine');
    await call(fixture, 'snapshot', {});
    // A slow click: the person presses Take over while it runs.
    let finish = () => {};
    const sendCommand = page?.debugger.sendCommand;
    if (!page || !sendCommand) throw new Error('no page');
    page.debugger.sendCommand = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent') await new Promise<void>(resolve => { finish = resolve; });
      return sendCommand(method, params);
    };
    const clicking = call(fixture, 'click', { x: 5, y: 5 });
    await vi.waitFor(() => expect(JSON.stringify(fixture.tabs.find(tab => tab.id === 'mine')?.state.customState)).toContain('"by":"agent"'));
    expect(await fixture.registry.invokeRemote('browser:driver', ['mine', 'person', 'phone-1'], { caller: undefined })).toEqual({ success: true });
    page.debugger.sendCommand = sendCommand;
    finish();
    await clicking;
    // The chip still says the person drives, after the agent's chip would have lingered out.
    await new Promise(resolve => setTimeout(resolve, 2_300));
    expect(JSON.stringify(fixture.tabs.find(tab => tab.id === 'mine')?.state.customState)).toContain('"by":"person"');
    let settled = false;
    const next = call(fixture, 'click', { x: 5, y: 5 }).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(settled).toBe(false);
    expect(JSON.stringify(fixture.tabs.find(tab => tab.id === 'mine')?.state.customState)).toContain('"agentWaiting"');
    await fixture.registry.invokeRemote('browser:driver', ['mine', 'agent', 'phone-1'], { caller: undefined });
    expect(await next).toMatchObject({ ok: true });
  });
});
