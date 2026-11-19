import type { IpcMain } from 'electron';
import { realpathSync, statSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { PaneError, reasonOf } from '../../../shared/paneError';
import type { BrowserPanelState, ToolPanel } from '../../../shared/types/panels';
import type { DeviceDriver } from '../../../shared/types/devices';
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from '../../../shared/types/browser';
import { agentLabel } from '../../../shared/agents';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../shared/validation/boundaryDecoder';
import { isRemotePaneCommand, paneCommandCaller, paneCommandSignal, teammatePaneCaller, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { DeviceDriverGate } from '../services/devices/deviceDriverGate';
import { PageDriver, WAIT_DEFAULT_MS, WAIT_MAX_MS, type ActionOutcome, type BrowserPageContents, type PendingDialog } from '../services/browser/pageDriver';

/**
 * Where the browser tools find tabs and pages. Main's default reads the panel store and the page
 * map the renderer fills on dom-ready; tests pass their own.
 */
export interface BrowserHost {
  /** The browser tabs of a Pane, in tab order. */
  tabs(paneId: string): ToolPanel[];
  tab(panelId: string): ToolPanel | undefined;
  /** Opens a browser tab in a split beside the caller, owned by it; never raises the window. */
  open(paneId: string, url: string, callerPanelId: string | undefined): Promise<ToolPanel>;
  /** Brings the tab forward on clients showing its Pane, so its page loads. */
  show(tab: ToolPanel): Promise<void>;
  close(tab: ToolPanel): Promise<void>;
  /** Writes the tab's state (the driver chip and its URL). */
  update(tab: ToolPanel, state: BrowserPanelState): Promise<void>;
  /** The tab's live page on this machine, the newest one the renderer registered. */
  page(panelId: string): BrowserPageContents | undefined;
  /** Whether this Pane has a window that can show a tab (headless hosts have none). */
  hasWindow(): boolean;
  /** Where a Pane's screenshots go: its scratch folder, deleted with the Pane. */
  shotsDirectory(paneId: string): Promise<string>;
  /** Shows the agent's cursor where it clicked, in the tab. */
  showCursor(panelId: string, x: number, y: number): void;
}

/** One tab as browser_tabs lists it (the contract's browserTab). */
interface TabSummary { id: string; url: string; title: string; openedBy: string; yours: boolean; driving?: string; showing: boolean; dialog?: PendingDialog }
/** What an action on a tab returns (the contract's browserActionResult). */
interface ActionResult { ok: true; tab: string; url: string; title: string; dialog?: PendingDialog; fileChooser?: ActionOutcome['fileChooser']; note?: string }
interface SnapshotResult { ok: true; tab: string; url: string; title: string; snapshot: string; truncated?: boolean; note?: string }
interface WaitConditions { text?: string; url?: string; ref?: string }

/** What the browser tools read from the app: the caller's Pane and Settings > Browser. */
export interface BrowserServices {
  sessionManager: { getSession(paneId: string): { name: string; worktreePath?: string } | undefined };
  configManager: { getConfig(): { browser?: Partial<BrowserSettings> } };
}

/** Who called: the agent's Pane and tab. */
interface BrowserCaller { paneId: string; panelId?: string; worktree?: string }

const PAGE_WAIT_MS = 5_000;
/** The person drives until this long after their last touch on a page an agent was driving. */
export const TOUCH_HOLD_MS = 750;
/** Password-like and key files browser_upload never sends. */
const CREDENTIAL_FILE = /(^\.env(\..*)?$)|(\.(pem|key|p12|pfx|kdbx)$)|(^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$)|(^\.(npmrc|netrc|pypirc|git-credentials|pgpass)$)|(^credentials(\.json)?$)/i;

const tabField = boundary.optional(boundary.string);
const refField = boundary.optional(boundary.string);
const schemas = {
  open: boundary.object({ url: boundary.string }),
  tabs: boundary.object({}),
  close: boundary.object({ tab: tabField }),
  snapshot: boundary.object({ tab: tabField }),
  screenshot: boundary.object({ tab: tabField, fullPage: boundary.optional(boundary.boolean) }),
  click: boundary.object({ tab: tabField, ref: refField, x: boundary.optional(boundary.number), y: boundary.optional(boundary.number), button: boundary.optional(boundary.enumeration('left', 'right', 'middle')), double: boundary.optional(boundary.boolean) }),
  type: boundary.object({ tab: tabField, ref: boundary.string, text: boundary.string, clear: boundary.optional(boundary.boolean), submit: boundary.optional(boundary.boolean) }),
  press: boundary.object({ tab: tabField, key: boundary.string, ref: refField }),
  select: boundary.object({ tab: tabField, ref: boundary.string, values: boundary.array(boundary.string) }),
  scroll: boundary.object({ tab: tabField, ref: refField, dx: boundary.optional(boundary.number), dy: boundary.optional(boundary.number) }),
  navigate: boundary.object({ tab: tabField, url: boundary.optional(boundary.string), back: boundary.optional(boundary.boolean), forward: boundary.optional(boundary.boolean), reload: boundary.optional(boundary.boolean) }),
  wait: boundary.object({ tab: tabField, text: boundary.optional(boundary.string), url: boundary.optional(boundary.string), ref: refField, timeoutMs: boundary.optional(boundary.number) }),
  dialog: boundary.object({ tab: tabField, accept: boundary.optional(boundary.boolean), dismiss: boundary.optional(boundary.boolean), text: boundary.optional(boundary.string) }),
  evaluate: boundary.object({ tab: tabField, expression: boundary.string, ref: refField }),
  upload: boundary.object({ tab: tabField, ref: refField, paths: boundary.array(boundary.string) }),
};

function decode<Value>(verb: string, value: PaneCommandValue, schema: BoundarySchema<Value>): Value {
  try {
    return decodeBoundary(value ?? {}, schema);
  } catch (cause) {
    throw new PaneError('ERR_BROWSER_INVALID_REQUEST', `The browser ${verb} request is malformed: ${reasonOf(cause)}. Nothing ran.`, `See \`runpane help browser ${verb}\`.`);
  }
}

function invalid(text: string, next: string): PaneError {
  return new PaneError('ERR_BROWSER_INVALID_REQUEST', `${text} Nothing ran.`, next);
}

const driverSchema = boundary.optional(boundary.union(
  boundary.object({ by: boundary.literal('agent'), agent: boundary.string }),
  boundary.object({ by: boundary.literal('person'), agentWaiting: boundary.optional(boundary.string) }),
));
const tabStateSchema = boundary.object({ currentUrl: boundary.optional(boundary.string), isPopup: boundary.optional(boundary.boolean), driver: driverSchema });

function tabState(tab: ToolPanel): BrowserPanelState {
  const state = decodeOptionalBoundary(tab.state.customState, tabStateSchema);
  return state ? { ...state } : {};
}

/** Only http and https pages load for an agent. */
function checkedWebUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PaneError('ERR_BROWSER_URL_REFUSED', `"${raw}" is not a URL. Nothing ran.`, 'Pass a full http or https URL, such as http://localhost:3000.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PaneError('ERR_BROWSER_URL_REFUSED', `Agents may only load http and https pages, and ${url.protocol} is neither. Nothing ran.`, 'Pass an http or https URL. To show the person a local file, use panels_open.');
  }
  return url.toString();
}

/** A worktree file browser_upload may send: inside the worktree, a real file, and not a credential. */
function checkedUploadPath(worktree: string | undefined, raw: string): string {
  if (!worktree) throw new PaneError('ERR_BROWSER_PATH_REFUSED', 'This Pane has no worktree to upload files from. Nothing ran.', 'Run the agent in a Pane with a worktree.');
  let root: string;
  let file: string;
  try {
    root = realpathSync(worktree);
    file = realpathSync(path.resolve(worktree, raw));
  } catch {
    throw new PaneError('ERR_BROWSER_PATH_REFUSED', `${raw} does not exist in this Pane's worktree. Nothing ran.`, 'Pass the path of a file inside your worktree.');
  }
  const relative = path.relative(root, file);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PaneError('ERR_BROWSER_PATH_REFUSED', `${raw} is outside this Pane's worktree, and browser_upload sends only worktree files. Nothing ran.`, 'Copy the file into your worktree first if the person agrees it may be uploaded.');
  }
  const parts = relative.split(path.sep);
  if (parts.some(part => part === '.ssh' || part === '.gnupg' || part === '.aws') || CREDENTIAL_FILE.test(path.basename(file))) {
    throw new PaneError('ERR_BROWSER_PATH_REFUSED', `${raw} looks like a credential (a .env file, a key, or something under .ssh), and browser_upload never sends one. Nothing ran.`, 'Upload a different file, or ask the person to upload this one themselves.');
  }
  if (!statSync(file).isFile()) throw new PaneError('ERR_BROWSER_PATH_REFUSED', `${raw} is not a file. Nothing ran.`, 'Pass the path of a file.');
  return file;
}

/**
 * The browser tools (docs/BROWSER_AGENTS.md): agents read and act on the browser tabs of their own
 * Pane through `runpane:browser:*`. Writes run through the driver gate keyed by tab, so the person
 * sees who drives and can take over; calls on different tabs never wait on each other.
 */
export function registerBrowserHandlers(ipcMain: Pick<IpcMain, 'handle'>, services: BrowserServices, commandRegistry: PaneCommandRegistry, host: BrowserHost): void {
  const pages = new Map<number, PageDriver>();
  /** Tabs the person holds by touching the page; they go back to the agent TOUCH_HOLD_MS after the last touch. */
  const touchTimers = new Map<string, NodeJS.Timeout>();

  const gate = new DeviceDriverGate({
    kind: 'browser',
    read: (tabId) => { const tab = host.tab(tabId); return tab ? tabState(tab).driver : undefined; },
    write: async (tabId, driver) => { const tab = host.tab(tabId); if (tab) await host.update(tab, { ...tabState(tab), driver }); },
    waitMs: 4 * 60_000,
    pollMs: 250,
    lingerMs: 2_000,
  });

  const settings = (): BrowserSettings => ({ ...DEFAULT_BROWSER_SETTINGS, ...services.configManager.getConfig().browser });

  function callerOf(): BrowserCaller {
    if (isRemotePaneCommand()) {
      throw new PaneError('ERR_BROWSER_LOCAL_ONLY', 'Browser tools answer only agents running on this computer, and this call came from another one. Nothing ran.', 'Run the agent in a Pane on the computer that shows the tab.');
    }
    const caller = paneCommandCaller();
    const session = caller?.paneId ? services.sessionManager.getSession(caller.paneId) : undefined;
    if (!caller?.paneId || !session) {
      throw new PaneError('ERR_BROWSER_NO_PANE', 'Browser tools work only for agents running in a Pane tab, and this call came from outside one. Nothing ran.', 'Run the command from a terminal or agent tab inside a Pane.');
    }
    if (!settings().agentTools) {
      throw new PaneError('ERR_BROWSER_TOOLS_OFF', 'Agent browser tools are turned off in Settings > Browser. Nothing ran.', 'Use another browser tool, or ask the person to turn on Settings > Browser > Agent browser tools.');
    }
    const result: BrowserCaller = { paneId: caller.paneId };
    if (caller.panelId) result.panelId = caller.panelId;
    if (session.worktreePath) result.worktree = session.worktreePath;
    return result;
  }

  /** The agent named by the tab that called ("Claude Code"). */
  function agentName(panelId: string | undefined): string {
    const panel = panelId ? host.tab(panelId) : undefined;
    const custom = decodeOptionalBoundary(panel?.state.customState, boundary.object({ agent: boundary.optional(boundary.string), agentType: boundary.optional(boundary.string) }));
    const id = custom?.agent ?? custom?.agentType;
    return id ? agentLabel(id) : 'The agent';
  }

  /** "person", "you", or the opener's agent name. */
  function openerOf(tab: ToolPanel, caller: BrowserCaller): string {
    const opener = tab.metadata.openedBy;
    if (opener?.source !== 'agent' || !opener.panelId) return 'person';
    return opener.panelId === caller.panelId ? 'you' : agentName(opener.panelId);
  }

  /** An agent may act on its own tabs and the person's, and only read other agents' tabs. */
  function mayAct(tab: ToolPanel, caller: BrowserCaller): boolean {
    const who = openerOf(tab, caller);
    return who === 'person' || who === 'you';
  }

  function summary(tab: ToolPanel, caller: BrowserCaller) {
    const state = tabState(tab);
    const page = host.page(tab.id);
    const item: TabSummary = {
      id: tab.id,
      url: page?.getURL() || state.currentUrl || '',
      title: page?.getTitle() || tab.title,
      openedBy: openerOf(tab, caller),
      yours: mayAct(tab, caller),
      showing: page !== undefined,
    };
    if (state.driver) item.driving = state.driver.by === 'person' ? 'person' : state.driver.agent;
    const dialog = page ? pages.get(page.id)?.pendingDialog : undefined;
    if (dialog) item.dialog = dialog;
    return item;
  }

  function listing(tabs: ToolPanel[], caller: BrowserCaller): string {
    return tabs.map(tab => { const item = summary(tab, caller); return `${item.id} (${item.title || item.url}${item.yours ? '' : ', not yours'})`; }).join(', ');
  }

  /** The tab a call names, or the one it means when it names none. */
  function pickTab(caller: BrowserCaller, tabId: string | undefined, write: boolean): ToolPanel {
    const tabs = host.tabs(caller.paneId);
    if (tabId !== undefined) {
      const tab = tabs.find(candidate => candidate.id === tabId);
      if (!tab) throw new PaneError('ERR_BROWSER_NO_TAB', `This Pane has no browser tab ${tabId}. Nothing ran.`, tabs.length ? `Its browser tabs: ${listing(tabs, caller)}.` : 'Open one with browser_open.');
      if (write && !mayAct(tab, caller)) {
        throw new PaneError('ERR_BROWSER_NOT_YOURS', `${openerOf(tab, caller)} opened tab ${tab.id}, so you may read it but not act on it. Nothing ran.`, 'Open your own tab with browser_open, or act on a tab the person opened.');
      }
      return tab;
    }
    if (tabs.length === 0) throw new PaneError('ERR_BROWSER_NO_TAB', 'This Pane has no browser tab. Nothing ran.', 'Open one with browser_open and a URL.');
    const own = tabs.filter(tab => openerOf(tab, caller) === 'you');
    if (own.length === 1) return own[0];
    const usable = write ? tabs.filter(tab => mayAct(tab, caller)) : tabs;
    if (tabs.length === 1 && usable.length === 1) return tabs[0];
    if (usable.length === 0) throw new PaneError('ERR_BROWSER_NOT_YOURS', `Every browser tab in this Pane belongs to another agent: ${listing(tabs, caller)}. Nothing ran.`, 'Open your own tab with browser_open.');
    throw new PaneError('ERR_BROWSER_TAB_REQUIRED', `This Pane has ${tabs.length} browser tabs, so the call must name one. Nothing ran.`, `Pass --tab with one of: ${listing(tabs, caller)}.`);
  }

  /** The tab's live page, brought forward (and waited for) when it is not showing. */
  async function livePage(tab: ToolPanel): Promise<BrowserPageContents> {
    let page = host.page(tab.id);
    if (!page && host.hasWindow()) {
      await host.show(tab);
      const deadline = Date.now() + PAGE_WAIT_MS;
      while (!page && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        page = host.page(tab.id);
      }
    }
    if (!page) {
      const paneName = services.sessionManager.getSession(tab.sessionId)?.name ?? 'this Pane';
      throw new PaneError('ERR_BROWSER_NOT_SHOWING', host.hasWindow()
        ? `Tab ${tab.id} did not load its page within ${PAGE_WAIT_MS / 1000} seconds. A browser tab's page loads only while its Pane is open in Pane's window, and ${paneName} may not be. Nothing ran.`
        : `Tab ${tab.id} is not showing on this computer: this Pane runs without a window, so its pages exist only on a desktop that shows them. Nothing ran.`,
      host.hasWindow() ? `Ask the person to open ${paneName} in Pane, then try again.` : 'Open this Pane in Pane\'s desktop app on this computer, then try again.');
    }
    return page;
  }

  function driverFor(tab: ToolPanel, page: BrowserPageContents): PageDriver {
    let driver = pages.get(page.id);
    if (driver) return driver;
    driver = new PageDriver(page);
    pages.set(page.id, driver);
    page.once('destroyed', () => pages.delete(page.id));
    // The person touching a page an agent drives takes it over until they stop (TOUCH_HOLD_MS).
    page.on('input-event', (_event, input) => {
      if (!['mouseDown', 'rawKeyDown', 'keyDown', 'mouseWheel', 'touchStart', 'gestureScrollBegin'].includes(input.type)) return;
      const driver = pages.get(page.id);
      if (!driver || driver.isAgentInput()) return;
      // The person changed the page under the agent's refs, so they go stale either way.
      driver.revokeRefs();
      void personTouched(tab.id, page.id);
    });
    return driver;
  }

  async function personTouched(tabId: string, pageId: number): Promise<void> {
    const tab = host.tab(tabId);
    const current = tab ? tabState(tab).driver : undefined;
    const holding = touchTimers.has(tabId);
    if (current?.by !== 'agent' && !holding) return;
    clearTimeout(touchTimers.get(tabId));
    touchTimers.set(tabId, setTimeout(() => {
      touchTimers.delete(tabId);
      const now = host.tab(tabId);
      if (now && tabState(now).driver?.by === 'person') void gate.set(tabId, undefined);
    }, TOUCH_HOLD_MS));
    if (current?.by === 'agent') {
      pages.get(pageId)?.revokeRefs();
      await gate.set(tabId, { by: 'person' });
    }
  }

  /** The person pressed Take over or Hand to agent in the tab's chip. */
  async function setDriverFromChip(tabId: string, who: 'person' | 'agent'): Promise<void> {
    clearTimeout(touchTimers.get(tabId));
    touchTimers.delete(tabId);
    const page = host.page(tabId);
    if (who === 'person' && page) pages.get(page.id)?.revokeRefs();
    const tab = host.tab(tabId);
    const waiting = tab ? tabState(tab).driver : undefined;
    const driver: DeviceDriver | undefined = who === 'person' ? (waiting?.by === 'person' ? waiting : { by: 'person' }) : undefined;
    await gate.set(tabId, driver);
  }

  /** The tab's live page, refused when agents may not use it: DevTools open (writes), or not a web page. */
  async function usablePage(tab: ToolPanel, write: boolean): Promise<BrowserPageContents> {
    const contents = await livePage(tab);
    if (write && (contents.isDevToolsOpened() || (contents.devToolsWebContents !== null && !contents.devToolsWebContents.isDestroyed()))) {
      throw new PaneError('ERR_BROWSER_DEVTOOLS_OPEN', `DevTools is open on tab ${tab.id}, and agents don't act on a page while the person inspects it. Nothing ran.`, 'Ask the person to close DevTools on that tab, then try again.');
    }
    refuseNonWebPage(tab, contents, 'shows');
    return contents;
  }

  /** Agents read and act only on http(s) pages (and a blank one): never a file: or chrome: page in a tab. */
  function refuseNonWebPage(tab: ToolPanel, contents: BrowserPageContents, verb: 'shows' | 'is now on'): void {
    let protocol = '';
    try { protocol = new URL(contents.getURL()).protocol; } catch { protocol = ''; }
    if (protocol === 'http:' || protocol === 'https:' || contents.getURL() === 'about:blank' || contents.getURL() === '') return;
    throw new PaneError('ERR_BROWSER_URL_REFUSED', `Tab ${tab.id} ${verb} a ${protocol || 'non-web'} page, and agents read and act only on http and https pages.${verb === 'is now on' ? ' The call ran; nothing more will on that page.' : ' Nothing ran.'}`, 'Load an http or https page with browser_navigate, or use another tab.');
  }

  /** Runs a call on a tab: reads go straight through; writes wait their turn behind the person. */
  async function onTab<Result>(caller: BrowserCaller, tabId: string | undefined, write: boolean, work: (page: PageDriver, tab: ToolPanel, contents: BrowserPageContents) => Promise<Result>): Promise<Result> {
    const tab = pickTab(caller, tabId, write);
    const run = async () => {
      const contents = await usablePage(tab, write);
      const result = await work(driverFor(tab, contents), tab, contents);
      refuseNonWebPage(tab, contents, 'is now on');
      return result;
    };
    return write ? gate.run(tab.id, agentName(caller.panelId), paneCommandSignal(), run) : run();
  }

  function after(tab: ToolPanel, contents: BrowserPageContents, outcome: ActionOutcome = {}) {
    const result: ActionResult = { ok: true, tab: tab.id, url: contents.getURL(), title: contents.getTitle() };
    if (outcome.dialog) {
      result.dialog = outcome.dialog;
      result.note = 'The page opened a dialog and is blocked until it is answered. Answer it with browser_dialog.';
    }
    if (outcome.fileChooser) {
      result.fileChooser = outcome.fileChooser;
      result.note = 'The page opened a file picker. Fill it with browser_upload and --paths, leaving --ref out.';
    }
    return result;
  }

  commandRegistry.register('runpane:browser:open', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { url: raw } = decode('open', request, schemas.open);
    const url = checkedWebUrl(raw);
    const origin = new URL(url).origin;
    const own = host.tabs(caller.paneId).find(tab => openerOf(tab, caller) === 'you' && (() => { try { return new URL(host.page(tab.id)?.getURL() || tabState(tab).currentUrl || '').origin === origin; } catch { return false; } })());
    if (own) {
      return gate.run(own.id, agentName(caller.panelId), paneCommandSignal(), async () => {
        const contents = await usablePage(own, true);
        await driverFor(own, contents).navigate({ url });
        return { ...after(own, contents), reused: true, next: 'Read it with browser_snapshot, then act on refs.' };
      });
    }
    const tab = await host.open(caller.paneId, url, caller.panelId);
    const contents = await livePage(tab);
    return { ...after(tab, contents), reused: false, next: 'Read it with browser_snapshot, then act on refs. Close it with browser_close when you are done.' };
  });

  commandRegistry.register('runpane:browser:tabs', async (request: PaneCommandValue) => {
    const caller = callerOf();
    decode('tabs', request, schemas.tabs);
    return { ok: true, tabs: host.tabs(caller.paneId).map(tab => summary(tab, caller)) };
  });

  commandRegistry.register('runpane:browser:close', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId } = decode('close', request, schemas.close);
    const tab = pickTab(caller, tabId, true);
    if (openerOf(tab, caller) !== 'you') {
      throw new PaneError('ERR_BROWSER_NOT_YOURS', `Tab ${tab.id} was opened by ${openerOf(tab, caller) === 'person' ? 'the person' : openerOf(tab, caller)}, and agents close only the tabs they opened. Nothing ran.`, 'Leave it open, or ask the person to close it.');
    }
    await gate.run(tab.id, agentName(caller.panelId), paneCommandSignal(), () => host.close(tab));
    return { ok: true, tab: tab.id };
  });

  commandRegistry.register('runpane:browser:snapshot', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId } = decode('snapshot', request, schemas.snapshot);
    return onTab(caller, tabId, false, async (page, tab) => {
      const shot = await page.snapshot();
      const result: SnapshotResult = { ok: true, tab: tab.id, ...shot };
      if (shot.truncated) result.note = 'The page is long, so text past the limit was left out; every control on the page still has a ref. Use browser_evaluate to read a part of the text.';
      else delete result.truncated;
      return result;
    });
  });

  commandRegistry.register('runpane:browser:screenshot', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, fullPage } = decode('screenshot', request, schemas.screenshot);
    return onTab(caller, tabId, false, async (page, tab) => {
      const shot = await page.screenshot(fullPage === true);
      const directory = await host.shotsDirectory(tab.sessionId);
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `${tab.id}-${Date.now()}.png`);
      await writeFile(file, shot.png);
      return { ok: true, tab: tab.id, path: file, mimeType: 'image/png', width: shot.width, height: shot.height };
    });
  });

  commandRegistry.register('runpane:browser:click', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, ref, x, y, button, double } = decode('click', request, schemas.click);
    const target = ref !== undefined ? { ref } : x !== undefined && y !== undefined ? { x, y } : undefined;
    if (!target) throw invalid('browser_click needs a ref, or both x and y.', 'Pass a ref from browser_snapshot.');
    return onTab(caller, tabId, true, async (page, tab, contents) => {
      const clicked = await page.click(target, button ?? 'left', double === true);
      host.showCursor(tab.id, clicked.x, clicked.y);
      return after(tab, contents, clicked);
    });
  });

  commandRegistry.register('runpane:browser:type', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, ref, text, clear, submit } = decode('type', request, schemas.type);
    return onTab(caller, tabId, true, async (page, tab, contents) => after(tab, contents, await page.type(ref, text, clear === true, submit === true)));
  });

  commandRegistry.register('runpane:browser:press', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, key, ref } = decode('press', request, schemas.press);
    return onTab(caller, tabId, true, async (page, tab, contents) => after(tab, contents, await page.press(key, ref)));
  });

  commandRegistry.register('runpane:browser:select', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, ref, values } = decode('select', request, schemas.select);
    if (values.length === 0) throw invalid('browser_select needs at least one value.', 'Pass --values with the options to choose.');
    return onTab(caller, tabId, true, async (page, tab, contents) => {
      const selected = await page.select(ref, values);
      return { ...after(tab, contents), note: `Selected: ${selected.join(', ')}` };
    });
  });

  commandRegistry.register('runpane:browser:scroll', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, ref, dx, dy } = decode('scroll', request, schemas.scroll);
    if (ref === undefined && !dx && !dy) throw invalid('browser_scroll needs a distance (dx or dy) or a ref to scroll into view.', 'Pass --dy 600 to scroll down a screen.');
    return onTab(caller, tabId, true, async (page, tab, contents) => {
      await page.scroll(ref, dx ?? 0, dy ?? 0);
      return after(tab, contents);
    });
  });

  commandRegistry.register('runpane:browser:navigate', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, url, back, forward, reload } = decode('navigate', request, schemas.navigate);
    const chosen = [url !== undefined, back === true, forward === true, reload === true].filter(Boolean).length;
    if (chosen !== 1) throw invalid('browser_navigate takes exactly one of url, back, forward or reload.', 'Pass a URL, or one of back, forward or reload.');
    const target = url !== undefined ? { url: checkedWebUrl(url) } : { history: back ? 'back' as const : forward ? 'forward' as const : 'reload' as const };
    return onTab(caller, tabId, true, async (page, tab, contents) => {
      await page.navigate(target);
      return after(tab, contents);
    });
  });

  commandRegistry.register('runpane:browser:wait', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, text, url, ref, timeoutMs } = decode('wait', request, schemas.wait);
    if (text === undefined && url === undefined && ref === undefined) throw invalid('browser_wait needs at least one of text, url or ref.', 'Pass --text with what the page should show.');
    const conditions: WaitConditions = {};
    if (text !== undefined) conditions.text = text;
    if (url !== undefined) conditions.url = url;
    if (ref !== undefined) conditions.ref = ref;
    const timeout = Math.min(Math.max(timeoutMs ?? WAIT_DEFAULT_MS, 0), WAIT_MAX_MS);
    return onTab(caller, tabId, false, async (page, tab, contents) => {
      await page.wait(conditions, timeout);
      return after(tab, contents, page.pendingDialog ? { dialog: page.pendingDialog } : {});
    });
  });

  commandRegistry.register('runpane:browser:dialog', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, accept, dismiss, text } = decode('dialog', request, schemas.dialog);
    if ((accept === true) === (dismiss === true)) throw invalid('browser_dialog takes exactly one of accept or dismiss.', 'Pass --accept to press OK, or --dismiss to press Cancel.');
    return onTab(caller, tabId, true, async (page, tab, contents) => {
      const answered = await page.answerDialog(accept === true, text);
      return { ...after(tab, contents), note: `${accept ? 'Accepted' : 'Dismissed'} the ${answered.type} "${answered.message.slice(0, 120)}".` };
    });
  });

  commandRegistry.register('runpane:browser:evaluate', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, expression, ref } = decode('evaluate', request, schemas.evaluate);
    return onTab(caller, tabId, true, async (page, tab, contents) => {
      const { value, truncated } = await page.evaluate(expression, ref);
      const result: ReturnType<typeof after> & { value: unknown; truncated?: boolean } = { ...after(tab, contents), value };
      if (truncated) {
        result.truncated = true;
        result.note = 'The value was over 64 KB, so it is cut off: value holds the start of its JSON text. Return less, such as one field or a slice.';
      }
      return result;
    });
  });

  commandRegistry.register('runpane:browser:upload', async (request: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId, ref, paths } = decode('upload', request, schemas.upload);
    if (paths.length === 0) throw invalid('browser_upload needs at least one path.', 'Pass --paths with files in your worktree.');
    const files = paths.map(file => checkedUploadPath(caller.worktree, file));
    return onTab(caller, tabId, true, async (page, tab, contents) => {
      await page.upload(ref, files);
      return { ...after(tab, contents), note: `Set ${files.map(file => path.basename(file)).join(', ')}.` };
    });
  });


  /** The tab's chip: Take over and Hand to agent. Only Pane's own UI may call it, never an agent. */
  ipcMain.handle('browser-panel:driver', async (_event, panelId: PaneCommandValue, who: PaneCommandValue) => {
    if (paneCommandCaller() || teammatePaneCaller()) return { success: false, error: 'This channel belongs to the person\'s browser tab.' };
    const id = decodeOptionalBoundary(panelId, boundary.string);
    if (!id || !host.tab(id) || (who !== 'person' && who !== 'agent')) return { success: false, error: 'That browser tab is gone.' };
    await setDriverFromChip(id, who);
    return { success: true };
  });
}
