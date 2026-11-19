import { EventEmitter } from 'events';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import type { PaneDaemonCaller } from '../../../shared/types/daemon';
import type { BrowserPanelState, ToolPanel } from '../../../shared/types/panels';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { BrowserPageContents } from '../services/browser/pageDriver';
import { registerBrowserHandlers, TOUCH_HOLD_MS, type BrowserHost, type BrowserServices, type LinkedComputers, type TabDownload } from './browser';
import { readFileSync } from 'fs';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import type { JsonObject } from '../../../shared/validation/boundaryDecoder';

/** A page that answers the page script and the debugger the way a simple form page would. */
function fakePage(id: number, url: string): BrowserPageContents & EventEmitter & { sent: string[]; files: string[] } {
  const events = new EventEmitter();
  const sent: string[] = [];
  const files: string[] = [];
  let attached = false;
  const page = Object.assign(events, {
    id,
    sent,
    files,
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
      sendCommand: async (method: string, params?: { files?: string[] }) => {
        sent.push(method);
        if (method === 'DOM.setFileInputFiles') files.push(...(params?.files ?? []));
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

/** `pagesHere: false` leaves this computer without pages, as when only a linked computer shows the tabs. */
function setup(initial: ToolPanel[] = [], options: { linked?: LinkedComputers; pagesHere?: boolean; cursors?: string[] } = {}): Fixture {
  const worktree = mkdtempSync(path.join(os.tmpdir(), 'pane-browser-tools-'));
  let tools = true;
  const tabs = [agentTab('claude-a', 'pane-a', 'claude'), agentTab('codex-a', 'pane-a', 'codex'), ...initial];
  const pages = new Map<string, ReturnType<typeof fakePage>>();
  let nextPage = 1;
  let downloadListener: ((download: TabDownload) => void) | undefined;
  const shownDownloads: Array<[string, string]> = [];
  if (options.pagesHere !== false) {
    for (const tab of initial) {
      // SAFETY: browserTab builds every initial tab's customState as a BrowserPanelState.
      const state = tab.state.customState as BrowserPanelState | undefined;
      pages.set(tab.id, fakePage(nextPage++, state?.currentUrl ?? 'http://localhost:4173/'));
    }
  }
  const host: BrowserHost = {
    tabs: (paneId) => tabs.filter(tab => tab.sessionId === paneId && tab.type === 'browser'),
    tab: (id) => tabs.find(tab => tab.id === id),
    open: async (paneId, url, callerPanelId) => {
      const tab = browserTab(`tab-${tabs.length}`, paneId, callerPanelId, url);
      tabs.push(tab);
      pages.set(tab.id, fakePage(nextPage++, url));
      return tab;
    },
    show: async () => undefined,
    close: async (tab) => { tabs.splice(tabs.indexOf(tab), 1); },
    update: async (tab, state) => { tab.state = { ...tab.state, customState: state }; },
    page: (id) => pages.get(id),
    tunnels: () => new Map(),
    hasWindow: () => true,
    shotsDirectory: async () => path.join(worktree, '.shots'),
    showCursor: (panelId) => { options.cursors?.push(panelId); },
    linked: () => options.linked,
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
    sessionManager: { getSession: (id: string) => (id === 'pane-a' || id === 'pane-b' ? { name: id, worktreePath: worktree } : undefined) },
    configManager: { getConfig: () => ({ browser: { agentTools: tools } }) },
  };
  const registry = new PaneCommandRegistry();
  registerBrowserHandlers(services, registry, host);
  return { registry, tabs, pages, setTools: (on) => { tools = on; }, worktree, download, shownDownloads };
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

describe('browser tools: a tab a linked computer shows (P2)', () => {
  /** The agent's computer, whose tab only the linked desktop shows, wired to that desktop's real channel. */
  function linkedPair(duringRun?: () => Promise<void>) {
    const viewerCursors: string[] = [];
    const viewer = setup([], { cursors: viewerCursors });
    viewer.pages.set('shown-there', fakePage(9, 'http://localhost:4173/'));
    const linked: LinkedComputers = {
      self: { id: 'devbox', name: 'DEVBOX' },
      online: () => [{ id: 'mac', name: 'Mac' }],
      invoke: async (_machine, request, _timeout) => {
        if (duringRun && JSON.parse(JSON.stringify(request)).op === 'run') await duringRun();
        return viewer.registry.invokeRemote('runpane:machine:browser', [request], { caller: { paneId: 'remote' } });
      },
    };
    const agentSide = setup([browserTab('shown-there', 'pane-a', 'claude-a')], { linked, pagesHere: false });
    return { agentSide, viewer, viewerCursors };
  }

  it('runs the call on the linked computer\'s copy and brings a screenshot home', async () => {
    const { agentSide, viewer, viewerCursors } = linkedPair();
    expect(await call(agentSide, 'snapshot', {})).toMatchObject({ ok: true, tab: 'shown-there', snapshot: expect.stringContaining('[ref=e2]') });
    const clicked = await call(agentSide, 'click', { ref: 'e2' });
    expect(clicked).toMatchObject({ ok: true });
    expect(viewerCursors).toEqual(['shown-there']);
    const shot = await call(agentSide, 'screenshot', {});
    expect(shot).toMatchObject({ ok: true, mimeType: 'image/png' });
    // Results carry only what the published output schemas allow (MCP clients reject the rest).
    const schemas = RUNPANE_CONTRACT.jsonSchemas;
    expect(Object.keys(JSON.parse(JSON.stringify(clicked))).filter(key => !(key in schemas.browserActionResult.properties))).toEqual([]);
    expect(Object.keys(JSON.parse(JSON.stringify(shot))).filter(key => !(key in schemas.browserScreenshotResult.properties))).toEqual([]);
    expect(readFileSync(JSON.parse(JSON.stringify(shot)).path, 'utf8')).toBe('png');
    expect(viewer.pages.get('shown-there')?.sent).toContain('Input.dispatchMouseEvent');
  });

  it('makes the agent wait after Take over on the linked computer, and stales its refs there', async () => {
    const { agentSide } = linkedPair();
    await call(agentSide, 'snapshot', {});
    // The viewing desktop's chip reaches the agent's computer as a host channel.
    expect(await agentSide.registry.invokeRemote('browser:driver', ['shown-there', 'person'], { caller: undefined })).toEqual({ success: true });
    const waiting = code(call(agentSide, 'click', { ref: 'e2' }));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(JSON.stringify(agentSide.tabs.find(tab => tab.id === 'shown-there')?.state.customState)).toContain('"agentWaiting":"Claude"');
    await agentSide.registry.invokeRemote('browser:driver', ['shown-there', 'agent'], { caller: undefined });
    expect(await waiting).toBe('ERR_BROWSER_STALE_REF');
  });

  it('waits while the person uses the page on the linked computer', async () => {
    const { agentSide, viewer } = linkedPair();
    await call(agentSide, 'snapshot', {});
    await call(agentSide, 'click', { ref: 'e2' });
    await new Promise(resolve => setTimeout(resolve, 400));
    viewer.pages.get('shown-there')?.emit('input-event', {}, { type: 'mouseDown' });
    const started = Date.now();
    expect(await code(call(agentSide, 'click', { ref: 'e2' }))).toBe('ERR_BROWSER_STALE_REF');
    expect(Date.now() - started).toBeGreaterThanOrEqual(TOUCH_HOLD_MS - 300);
    // The touch ended, so the tab is the agent's again: the next call runs at once.
    expect(JSON.stringify(agentSide.tabs.find(tab => tab.id === 'shown-there')?.state.customState)).not.toContain('"by":"person"');
    await call(agentSide, 'snapshot', {});
    const again = Date.now();
    expect(await call(agentSide, 'click', { ref: 'e2' })).toMatchObject({ ok: true });
    expect(Date.now() - again).toBeLessThan(TOUCH_HOLD_MS);
  });

  it('keeps the person driving when they press Take over during a call on the linked computer', async () => {
    let holdRun = false;
    let running = () => {};
    let release = () => {};
    const { agentSide } = linkedPair(async () => {
      if (!holdRun) return;
      running();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await call(agentSide, 'snapshot', {});
    holdRun = true;
    const inside = new Promise<void>(resolve => { running = resolve; });
    const clicking = call(agentSide, 'click', { ref: 'e2' });
    await inside;
    // The person presses Take over while the click runs on the linked computer.
    expect(await agentSide.registry.invokeRemote('browser:driver', ['shown-there', 'person'], { caller: undefined })).toEqual({ success: true });
    release();
    await clicking.catch(() => undefined);
    expect(JSON.stringify(agentSide.tabs.find(tab => tab.id === 'shown-there')?.state.customState)).toContain('"by":"person"');
  });

  it('keeps an uploaded file on the linked computer until the page goes, so the form can still send it', async () => {
    const { agentSide, viewer } = linkedPair();
    writeFileSync(path.join(agentSide.worktree, 'report.pdf'), 'pdf');
    await call(agentSide, 'snapshot', {});
    expect(await call(agentSide, 'upload', { ref: 'e1', paths: ['report.pdf'] })).toMatchObject({ ok: true });
    const page = viewer.pages.get('shown-there');
    const [copy] = page?.files ?? [];
    expect(readFileSync(copy ?? '', 'utf8')).toBe('pdf');
    page?.emit('destroyed');
    await vi.waitFor(() => expect(existsSync(copy ?? '')).toBe(false));
  });

  it('refuses a localhost port the viewing computer has no tunnel for, rather than load its own', async () => {
    const { agentSide } = linkedPair();
    expect(await code(call(agentSide, 'navigate', { url: 'http://localhost:3000/' }))).toBe('ERR_BROWSER_URL_REFUSED');
  });

  it('stops using a linked computer that dropped off, and asks again on the next call', async () => {
    let offline = false;
    const { agentSide } = linkedPair(async () => {
      if (offline) throw new PaneError('ERR_REMOTE_OFFLINE', 'Mac is not connected.', 'Reconnect.');
    });
    await call(agentSide, 'snapshot', {});
    offline = true;
    // The call never reached the Mac, so it runs on this computer's copy, which here has no page.
    expect(await code(call(agentSide, 'click', { ref: 'e2' }))).toMatch(/ERR_BROWSER_NOT_(LINKED|SHOWING)/);
    offline = false;
    expect(await call(agentSide, 'snapshot', {})).toMatchObject({ ok: true });
  }, 15_000);
});
