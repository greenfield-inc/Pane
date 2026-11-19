import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import type { PaneDaemonCaller } from '../../../shared/types/daemon';
import type { BrowserPanelState, ToolPanel } from '../../../shared/types/panels';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { BrowserPageContents } from '../services/browser/pageDriver';
import { registerBrowserHandlers, TOUCH_HOLD_MS, type BrowserHost, type BrowserServices } from './browser';
import type { JsonObject } from '../../../shared/validation/boundaryDecoder';

/** A page that answers the page script and the debugger the way a simple form page would. */
function fakePage(id: number, url: string): BrowserPageContents & EventEmitter & { sent: string[] } {
  const events = new EventEmitter();
  const sent: string[] = [];
  let attached = false;
  const page = Object.assign(events, {
    id,
    sent,
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
      return true;
    },
    debugger: Object.assign(new EventEmitter(), {
      attach: () => { attached = true; },
      isAttached: () => attached,
      detach: () => { attached = false; },
      sendCommand: async (method: string) => {
        sent.push(method);
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

function setup(initial: ToolPanel[] = []): Fixture {
  const worktree = mkdtempSync(path.join(os.tmpdir(), 'pane-browser-tools-'));
  let tools = true;
  const tabs = [agentTab('claude-a', 'pane-a', 'claude'), agentTab('codex-a', 'pane-a', 'codex'), ...initial];
  const pages = new Map<string, ReturnType<typeof fakePage>>();
  let nextPage = 1;
  for (const tab of initial) pages.set(tab.id, fakePage(nextPage++, 'http://localhost:4173/'));
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
    hasWindow: () => true,
    shotsDirectory: async () => path.join(worktree, '.shots'),
    showCursor: () => undefined,
  };
  const services: BrowserServices = {
    sessionManager: { getSession: (id: string) => (id === 'pane-a' || id === 'pane-b' ? { name: id, worktreePath: worktree } : undefined) },
    configManager: { getConfig: () => ({ browser: { agentTools: tools } }) },
  };
  const registry = new PaneCommandRegistry();
  registerBrowserHandlers({ handle: vi.fn() }, services, registry, host);
  return { registry, tabs, pages, setTools: (on) => { tools = on; }, worktree };
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
