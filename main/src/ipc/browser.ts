import { existsSync, mkdirSync, realpathSync, statSync } from 'fs';
import { copyFile, mkdir, rename, rm, writeFile } from 'fs/promises';
import os from 'os';
import { randomUUID } from 'crypto';
import path from 'path';
import { PaneError, reasonOf } from '../../../shared/paneError';
import type { BrowserPageSize, BrowserPanelState, ToolPanel } from '../../../shared/types/panels';
import type { DeviceDriver } from '../../../shared/types/devices';
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from '../../../shared/types/browser';
import { agentLabel } from '../../../shared/agents';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import { isRemotePaneCommand, paneCommandCaller, paneCommandSignal, teammatePaneCaller, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { DeviceDriverGate } from '../services/devices/deviceDriverGate';
import { PageDriver, WAIT_DEFAULT_MS, WAIT_MAX_MS, type BrowserPageContents, type FileChooser, type PendingDialog, type ScreencastSettings } from '../services/browser/pageDriver';
import type { BrowserFrame, BrowserFrameAnswer, BrowserInput, BrowserTabView } from '../../../shared/types/browserStream';
import { READ_VERBS, runVerb, type VerbOutcome, type VerbRequest } from '../services/browser/pageVerbs';
import { BrowserHolds, type ViewerKind, type WatchLimits } from '../services/browser/browserHolds';

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
  /** This computer's name, as other screens show it ("on studio-mac"). */
  name(): string;
  /** A folder for files a person on another screen gives a page, deleted when `page` closes. */
  uploadsFor(page: BrowserPageContents): Promise<string>;
  /**
   * The tabs whose pages stay alive while hidden: agents hold them (P4) or screens watch them.
   * `painting` are the ones another device watches, so a hidden page there keeps drawing.
   */
  setHeld(tabIds: readonly string[], painting: readonly string[]): void;
  /** Hears a tab closing for good or a Pane archived: agents whose tab is gone stop holding pages. */
  onGone(listener: () => void): void;
  /** A call runs on the tab: a hidden page paints while it does, so screenshots are current. */
  setBusy(panelId: string, busy: boolean): void;
  /** Calls `listener` for each download a page in a browser tab starts, before anything is saved. */
  onDownload(listener: (download: TabDownload) => void): void;
  /** Where the person's own downloads go: their Downloads folder. */
  personDownloads(): string;
  /** Where downloads an agent's call caused go: the Pane's scratch folder, deleted with the Pane. */
  agentDownloads(paneId: string): Promise<string>;
  /** Tells the tab a file finished downloading: "Downloaded <name> · Show in folder". */
  /** Shows the download's notice in the tab; `agent` names the agent whose call caused it. */
  showDownload(panelId: string, file: string, agent?: string): void;
}

/** A download a page started (Electron's will-download on the browser tabs' store). */
export interface TabDownload {
  /** The page that started it. */
  pageId: number;
  /** The tab that page shows in; undefined for a sign-in popup's own window. */
  tabId: string | undefined;
  /** The name the site suggests. */
  filename: string;
  /** Saves the file at `file`, with no dialog. Only during the onDownload listener call. */
  saveAs(file: string): void;
  /** True once the file is complete; false when it failed or was cancelled. */
  finished: Promise<boolean>;
}

/** One tab as browser_tabs lists it (the contract's browserTab). */
interface TabSummary { id: string; url: string; title: string; openedBy: string; yours: boolean; driving?: string; showing: boolean; held: boolean; asleep: boolean; watching: ViewerKind[]; size?: BrowserPageSize; dialog?: PendingDialog; downloads?: string[] }
/** What an action on a tab returns (the contract's browserActionResult). */
/** What a browser tool returns (the contract's browser*Result schemas). */
interface ToolResult { ok: true; tab: string; url?: string; title?: string; dialog?: PendingDialog; fileChooser?: FileChooser; note?: string; snapshot?: string; truncated?: boolean; value?: JsonValue; path?: string; mimeType?: 'image/png'; width?: number; height?: number; reused?: boolean; next?: string }

/** What the browser tools read from the app: the caller's Pane and Settings > Browser. */
export interface BrowserServices {
  sessionManager: { getSession(paneId: string): { name: string; worktreePath?: string; archived?: boolean } | undefined };
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
const pageSizeSchema = boundary.object({ width: boundary.number, height: boundary.number, mobile: boundary.boolean });
const tabStateSchema = boundary.object({ currentUrl: boundary.optional(boundary.string), isPopup: boundary.optional(boundary.boolean), driver: driverSchema, pageSize: boundary.optional(pageSizeSchema) });
/** What a screen showing a tab reports (`browser:watch`); null when it stops showing it. */
const watchReportSchema = boundary.optional(boundary.object({
  kind: boundary.enumeration('desktop', 'phone', 'web'),
  onScreen: boundary.boolean,
  width: boundary.number,
  height: boundary.number,
  scale: boundary.optional(boundary.number),
}));
const inputSchema: BoundarySchema<BrowserInput[]> = boundary.array(boundary.union(
  boundary.object({ kind: boundary.literal('mouse'), action: boundary.enumeration('move', 'down', 'up'), x: boundary.number, y: boundary.number, button: boundary.enumeration('none', 'left', 'middle', 'right'), clicks: boundary.number, modifiers: boundary.number }),
  boundary.object({ kind: boundary.literal('wheel'), x: boundary.number, y: boundary.number, dx: boundary.number, dy: boundary.number }),
  boundary.object({ kind: boundary.literal('touch'), action: boundary.enumeration('start', 'move', 'end'), x: boundary.number, y: boundary.number }),
  boundary.object({ kind: boundary.literal('key'), key: boundary.string, modifiers: boundary.number }),
  boundary.object({ kind: boundary.literal('text'), text: boundary.string }),
  boundary.object({ kind: boundary.literal('navigate'), url: boundary.string }),
  boundary.object({ kind: boundary.literal('history'), go: boundary.enumeration('back', 'forward', 'reload') }),
  boundary.object({ kind: boundary.literal('dialog'), accept: boundary.boolean, text: boundary.optional(boundary.string) }),
  boundary.object({ kind: boundary.literal('files'), files: boundary.array(boundary.object({ name: boundary.string, data: boundary.string })) }),
  boundary.object({ kind: boundary.literal('files-cancel') }),
));
/** How long a frame read waits on the host for a newer frame before answering "unchanged". */
const FRAME_WAIT_MS = 1_000;
/** The screencast stops this long after the last frame read. */
const STREAM_IDLE_MS = 10_000;
/** JPEG quality of streamed frames (T3 Code's default). */
const FRAME_QUALITY = 70;
/** How long a state read waits for a change before answering with the same state. */
const VIEW_WAIT_MS = 15_000;
/** Files a person sends one page's picker in one batch, at most (base64 grows it by a third). */
const PERSON_UPLOAD_BYTES = 10 * 1_048_576;
/** Electron's cursor names that differ from CSS's. */
const CSS_CURSOR = new Map([['nodrop', 'no-drop'], ['custom', 'default'], ['hand', 'pointer'], ['column-resize', 'col-resize']]);
/** The smallest and largest page a viewer may ask for, in CSS pixels. */
const PAGE_MIN = 100;
const PAGE_MAX = { width: 3840, height: 2160 };

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
 * Holds: how many tabs one agent keeps alive while hidden, and for how long without an action
 * (D-126); how many tabs the person's screens keep alive, for how long after the last one leaves,
 * and when a screen that stopped reporting counts as gone (D-134).
 */
export interface BrowserHoldSettings { limit: number; idleMs: number; sweepMs: number; watch: WatchLimits }
const DEFAULT_HOLDS: BrowserHoldSettings = { limit: 4, idleMs: 15 * 60_000, sweepMs: 5_000, watch: { limit: 8, graceMs: 15 * 60_000, silentMs: 15_000 } };

/**
 * The browser tools (docs/BROWSER_AGENTS.md): agents read and act on the browser tabs of their own
 * Pane through `runpane:browser:*`. Writes run through the driver gate keyed by tab, so the person
 * sees who drives and can take over; calls on different tabs never wait on each other. Returns what
 * stops the holds' sweep.
 */

export function registerBrowserHandlers(services: BrowserServices, commandRegistry: PaneCommandRegistry, host: BrowserHost, settingsOverride: Partial<BrowserHoldSettings> = {}): () => void {
  const holdSettings = { ...DEFAULT_HOLDS, ...settingsOverride };
  const pages = new Map<number, PageDriver>();
  /** Tabs another device watches: their pages keep painting and running while hidden here. */
  const remotelyWatched = (): string[] => holds.held().filter(tabId => holds.viewers(tabId).some(viewer => viewer.kind !== 'host'));
  const holds = new BrowserHolds({ limit: holdSettings.limit, idleMs: holdSettings.idleMs, watch: holdSettings.watch, onChange: held => host.setHeld(held, remotelyWatched()) });
  /** Whether this Pane had a window when the held tabs were last handed over. */
  let hadWindow = host.hasWindow();
  const sweep = () => {
    holds.sweep(
      // An agent is gone once its tab closed or its Pane was archived.
      agent => { const tab = host.tab(agent); return tab !== undefined && services.sessionManager.getSession(tab.sessionId)?.archived !== true; },
      // A dialog waiting for an answer counts as action.
      tabId => { const page = host.page(tabId); return page !== undefined && pages.get(page.id)?.pendingDialog !== undefined; },
      // The person closed the tab: it holds nothing and counts toward no limit.
      tabId => host.tab(tabId) !== undefined,
    );
    // The window closed or came back: the live pages move between it and hidden windows, so they
    // are handed over again (each reloads once from its URL).
    if (host.hasWindow() !== hadWindow) {
      hadWindow = host.hasWindow();
      host.setHeld(holds.held(), remotelyWatched());
    }
    for (const tabId of holds.held()) applyWatch(tabId);
    // Nobody read a page's frames for a while (the phone went to the background): stop encoding it.
    for (const [pageId, stream] of streams) {
      if (Date.now() - stream.lastRead < STREAM_IDLE_MS) continue;
      streams.delete(pageId);
      void stream.driver.stopScreencast();
    }
  };
  const sweeper = setInterval(sweep, holdSettings.sweepMs);
  sweeper.unref?.();
  // Closing the agent's tab or archiving its Pane puts its held tabs to sleep at once.
  host.onGone(sweep);
  /** Tabs the person holds by touching the page; they go back to the agent TOUCH_HOLD_MS after the last touch. */
  const touchTimers = new Map<string, NodeJS.Timeout>();
  /** Tabs the person took over with the chip: they hold them until Hand to agent. */
  const chipHeld = new Set<string>();
  /** How each live page was last set up for its watchers, so a report that changes nothing touches nothing. */
  const applied = new Map<number, string>();

  const gate = new DeviceDriverGate({
    kind: 'browser',
    read: (tabId) => { const tab = host.tab(tabId); return tab ? tabState(tab).driver : undefined; },
    write: async (tabId, driver) => { const tab = host.tab(tabId); if (tab) await host.update(tab, { ...tabState(tab), driver }); changedView(tabId); },
    waitMs: 4 * 60_000,
    pollMs: 250,
    lingerMs: 2_000,
  });

  const settings = (): BrowserSettings => ({ ...DEFAULT_BROWSER_SETTINGS, ...services.configManager.getConfig().browser });

  /** Files agents' calls downloaded, by tab, which browser_tabs lists. */
  const downloads = new Map<string, string[]>();

  /**
   * A download an agent's call caused (during its call, or while the chip still shows it driving)
   * saves into the Pane's scratch folder and browser_tabs lists it. Any other download is the
   * person's: it saves to their Downloads folder. Neither asks where to save.
   */
  host.onDownload(download => {
    const tab = download.tabId ? host.tab(download.tabId) : undefined;
    const byAgent = tab !== undefined && (pages.get(download.pageId)?.isAgentInput() === true || tabState(tab).driver?.by === 'agent');
    const name = path.basename(download.filename.replace(/\\/g, '/')) || 'download';
    if (!tab || !byAgent) {
      const file = unusedPath(host.personDownloads(), name);
      download.saveAs(file);
      void download.finished.then(done => { if (done && download.tabId) showDownload(download.tabId, file); });
      return;
    }
    // The scratch folder is found (and made) only after Electron needs the path, so the file saves
    // beside the system's temporary files first and moves when it is complete.
    const staging = path.join(os.tmpdir(), `pane-browser-download-${randomUUID()}`);
    mkdirSync(staging, { recursive: true });
    download.saveAs(path.join(staging, name));
    void download.finished.then(async done => {
      try {
        if (!done) return;
        const directory = await host.agentDownloads(tab.sessionId);
        await mkdir(directory, { recursive: true });
        const file = unusedPath(directory, name);
        await moveFile(path.join(staging, name), file);
        downloads.set(tab.id, [...(downloads.get(tab.id) ?? []), file]);
        const driver = tabState(tab).driver;
        showDownload(tab.id, file, driver?.by === 'agent' ? driver.agent : 'The agent');
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }).catch(error => console.error('[browser] Could not keep an agent\'s download:', error));
  });

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
      held: holds.isHeld(tab.id),
      // Asleep only while its page is really gone: a tab in view, or one the person reselected, has its page.
      asleep: holds.isAsleep(tab.id) && host.page(tab.id) === undefined,
      watching: [...new Set(holds.viewers(tab.id).filter(viewer => viewer.onScreen).map(viewer => viewer.kind))],
    };
    if (state.driver) item.driving = state.driver.by === 'person' ? 'person' : state.driver.agent;
    if (state.pageSize) item.size = state.pageSize;
    const dialog = page ? pages.get(page.id)?.pendingDialog : undefined;
    if (dialog) item.dialog = dialog;
    const saved = downloads.get(tab.id);
    if (saved) item.downloads = saved;
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
    // The tab is held (runLocal holds it before this runs), so this computer mounts its page, hidden
    // when it is not the tab in view; it never comes forward.
    if (!page) {
      const deadline = Date.now() + PAGE_WAIT_MS;
      while (!page && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        page = host.page(tab.id);
      }
    }
    if (!page) {
      const paneName = services.sessionManager.getSession(tab.sessionId)?.name ?? 'this Pane';
      const where = host.hasWindow() ? 'Pane\'s window' : 'a hidden window (Pane runs here without a window)';
      throw new PaneError('ERR_BROWSER_NOT_SHOWING', `Tab ${tab.id} in ${paneName} did not load its page in ${where} within ${PAGE_WAIT_MS / 1000} seconds. Nothing ran.`, `Try again. If it fails again, ask the person to open ${paneName} in Pane.`);
    }
    return page;
  }

  function driverFor(tabId: string, page: BrowserPageContents): PageDriver {
    let driver = pages.get(page.id);
    if (driver) return driver;
    driver = new PageDriver(page);
    pages.set(page.id, driver);
    page.once('destroyed', () => pages.delete(page.id));
    // The person touching a page an agent drives takes it over until they stop (TOUCH_HOLD_MS).
    page.on('input-event', (_event, input) => {
      if (!['mouseDown', 'rawKeyDown', 'keyDown', 'mouseWheel', 'touchStart', 'gestureScrollBegin'].includes(input.type)) return;
      const driver = pages.get(page.id);
      // Input from another screen took over through browser:input already.
      if (!driver || driver.isAgentInput() || driver.isForwardedInput()) return;
      // The person changed the page under the agent's refs, so they go stale either way.
      driver.notePersonInput();
      void personTouched(tabId, page.id);
      // The person here clicked into the tab: the page fills it again.
      if (tabOf(tabId)?.pageSize) void setPageSize(tabId, undefined);
    });
    return driver;
  }

  function tabOf(tabId: string): BrowserPanelState | undefined {
    const tab = host.tab(tabId);
    return tab ? tabState(tab) : undefined;
  }

  /**
   * Sets up a tab's live page for the screens watching it: a page another device watches keeps
   * running while hidden here, and makes no sound here unless this computer's window shows it.
   * A page that woke from sleep gets back the size a viewer gave it.
   */
  function applyWatch(tabId: string): void {
    const page = host.page(tabId);
    if (!page || page.isDestroyed()) return;
    const viewers = holds.viewers(tabId);
    const remote = viewers.some(viewer => viewer.kind !== 'host');
    const shownHere = viewers.some(viewer => viewer.kind === 'host' && viewer.onScreen);
    const key = JSON.stringify([remote, shownHere]);
    if (applied.get(page.id) !== key) {
      if (!applied.has(page.id)) page.once('destroyed', () => applied.delete(page.id));
      applied.set(page.id, key);
      page.setBackgroundThrottling(!remote);
      page.setAudioMuted(remote && !shownHere);
    }
    const size = tabOf(tabId)?.pageSize;
    const driver = size || pages.has(page.id) ? driverFor(tabId, page) : undefined;
    void driver?.setPageSize(size).catch(cause => console.warn(`[browser] Could not size tab ${tabId}'s page:`, cause));
  }

  /** Sets (or clears) the size a viewer in control gave the tab's page, and keeps it in the tab. */
  async function setPageSize(tabId: string, size: BrowserPageSize | undefined): Promise<void> {
    const tab = host.tab(tabId);
    if (!tab) return;
    const state = tabState(tab);
    if (JSON.stringify(state.pageSize ?? null) === JSON.stringify(size ?? null)) return;
    const next: BrowserPanelState = { ...state, pageSize: size };
    await host.update(tab, next);
    applyWatch(tabId);
    changedView(tabId);
  }

  /**
   * A person took control of the tab from one of their screens: the page takes that screen's size
   * (a phone's gets its phone layout). This computer's own window gives the page back its tab's size.
   */
  async function takeControl(tabId: string, viewerId: string): Promise<void> {
    const viewer = holds.viewers(tabId).find(candidate => candidate.id === viewerId);
    if (!viewer) return;
    if (viewer.kind === 'host') return setPageSize(tabId, undefined);
    const width = Math.round(Math.min(Math.max(viewer.width, PAGE_MIN), PAGE_MAX.width));
    const height = Math.round(Math.min(Math.max(viewer.height, PAGE_MIN), PAGE_MAX.height));
    return setPageSize(tabId, { width, height, mobile: viewer.kind === 'phone' });
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

  /** The person pressed Take over or Hand to agent in the tab's chip, on the screen `viewerId`. */
  async function setDriverFromChip(tabId: string, who: 'person' | 'agent', viewerId: string | undefined): Promise<void> {
    if (who === 'person') chipHeld.add(tabId);
    else chipHeld.delete(tabId);
    clearTimeout(touchTimers.get(tabId));
    touchTimers.delete(tabId);
    const page = host.page(tabId);
    if (who === 'person' && page) pages.get(page.id)?.revokeRefs();
    if (who === 'person' && viewerId) await takeControl(tabId, viewerId);
    const tab = host.tab(tabId);
    const waiting = tab ? tabState(tab).driver : undefined;
    const driver: DeviceDriver | undefined = who === 'person' ? (waiting?.by === 'person' ? waiting : { by: 'person' }) : undefined;
    await gate.set(tabId, driver);
  }


  /** Runs a verb on the tab's page, which lives on this computer; the agent holds the tab while it does. */
  async function runLocal(tab: ToolPanel, request: VerbRequest, write: boolean, holder: string): Promise<VerbOutcome> {
    // A page that is still here never went away, whatever the hold says.
    const hadPage = host.page(tab.id) !== undefined;
    const { evicted, wasAsleep } = holds.begin(holder, tab.id);
    try {
      const outcome = await runLocalHeld(tab, request, write);
      const notes = [
        wasAsleep && !hadPage ? `The tab was asleep (${holdSettings.idleMs / 60_000} minutes with no action, another tab took its place, or its agent went), so its page reloaded from its URL; anything typed there before is gone.` : undefined,
        evicted ? `You hold at most ${holdSettings.limit} tabs, so tab ${evicted} went to sleep; its page reloads when you next use it.` : undefined,
        outcome.note,
      ].filter(note => note !== undefined);
      if (notes.length) outcome.note = notes.join(' ');
      return outcome;
    } finally {
      holds.end(tab.id);
    }
  }

  async function runLocalHeld(tab: ToolPanel, request: VerbRequest, write: boolean): Promise<VerbOutcome> {
    const contents = await livePage(tab);
    if (write && devToolsOpen(contents)) {
      throw new PaneError('ERR_BROWSER_DEVTOOLS_OPEN', `DevTools is open on tab ${tab.id}, and agents don't act on a page while the person inspects it. Nothing ran.`, 'Ask the person to close DevTools on that tab, then try again.');
    }
    if (!loadsUrl(request)) refuseNonWebPage(contents, 'shows');
    host.setBusy(tab.id, true);
    let outcome: VerbOutcome;
    try {
      // A hidden page starts painting again for the call; give it a frame before capturing it.
      if (request.verb === 'screenshot') await new Promise(resolve => setTimeout(resolve, 150));
      outcome = await runVerb(driverFor(tab.id, contents), contents, request);
    } finally {
      host.setBusy(tab.id, false);
    }
    refuseNonWebPage(contents, 'is now on');
    if (outcome.cursor) {
      host.showCursor(tab.id, outcome.cursor.x, outcome.cursor.y);
      agentCursors.set(tab.id, { ...outcome.cursor, at: Date.now() });
      changedView(tab.id);
    }
    return outcome;
  }

  /**
   * Runs a verb on a tab's page, which lives on this computer whoever watches it (D-134). Reads go
   * straight through; writes wait their turn behind the person.
   */
  async function onTab(caller: BrowserCaller, tab: ToolPanel, request: VerbRequest): Promise<VerbOutcome> {
    const write = !READ_VERBS.has(request.verb);
    const run = () => runLocal(tab, request, write, caller.panelId ?? caller.paneId);
    return write ? gate.run(tab.id, agentName(caller.panelId), paneCommandSignal(), run) : run();
  }

  /** A verb's outcome as the tool returns it; a screenshot is saved on the agent's computer. */
  async function toolResult(tab: ToolPanel, outcome: VerbOutcome): Promise<ToolResult> {
    const { image, cursor: _cursor, ...rest } = outcome;
    const result: ToolResult = { ok: true, tab: tab.id, ...rest };
    if (image) {
      // A screenshot's result is the file; its schema has no url or title.
      delete result.url;
      delete result.title;
      const directory = await host.shotsDirectory(tab.sessionId);
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `${tab.id}-${Date.now()}.png`);
      await writeFile(file, image.png);
      Object.assign(result, { path: file, mimeType: 'image/png' as const, width: image.width, height: image.height });
    }
    return result;
  }

  /** Validates, picks the tab, runs the verb and shapes the result: the path of every tool but open, tabs and close. */
  function tool(verb: VerbRequest['verb'], build: (request: PaneCommandValue, caller: BrowserCaller) => { tab: string | undefined; request: VerbRequest }): void {
    commandRegistry.register(`runpane:browser:${verb}`, async (raw: PaneCommandValue) => {
      const caller = callerOf();
      const { tab: tabId, request } = build(raw, caller);
      const tab = pickTab(caller, tabId, !READ_VERBS.has(verb));
      return toolResult(tab, await onTab(caller, tab, request));
    });
  }

  commandRegistry.register('runpane:browser:open', async (raw: PaneCommandValue) => {
    const caller = callerOf();
    const url = checkedWebUrl(decode('open', raw, schemas.open).url);
    const origin = new URL(url).origin;
    const sameOrigin = (tab: ToolPanel) => {
      try { return new URL(host.page(tab.id)?.getURL() || tabState(tab).currentUrl || '').origin === origin; } catch { return false; }
    };
    const own = host.tabs(caller.paneId).find(tab => openerOf(tab, caller) === 'you' && sameOrigin(tab));
    if (own) {
      const result = await toolResult(own, await onTab(caller, own, { verb: 'navigate', url }));
      return { ...result, reused: true, next: 'Read it with browser_snapshot, then act on refs.' };
    }
    const tab = await host.open(caller.paneId, url, caller.panelId);
    // Returns once the new page has loaded, wherever it shows.
    const loaded = await waitForTab(caller, tab);
    return { ...(await toolResult(tab, loaded)), reused: false, next: 'Read it with browser_snapshot, then act on refs. Close it with browser_close when you are done.' };
  });

  /**
   * A new tab's page registers a moment after the tab opens. Returns once it registered: a page
   * still loading after WAIT_DEFAULT_MS comes back as it is.
   */
  async function waitForTab(caller: BrowserCaller, tab: ToolPanel): Promise<VerbOutcome> {
    try {
      return await onTab(caller, tab, { verb: 'wait', url: '', timeoutMs: WAIT_DEFAULT_MS });
    } catch (cause) {
      if (!(cause instanceof PaneError) || cause.code !== 'ERR_BROWSER_WAIT_TIMEOUT') throw cause;
      return { url: host.page(tab.id)?.getURL() || tabState(tab).currentUrl || '', title: tab.title };
    }
  }

  commandRegistry.register('runpane:browser:tabs', async (raw: PaneCommandValue) => {
    const caller = callerOf();
    decode('tabs', raw, schemas.tabs);
    return { ok: true, tabs: host.tabs(caller.paneId).map(tab => summary(tab, caller)) };
  });

  commandRegistry.register('runpane:browser:close', async (raw: PaneCommandValue) => {
    const caller = callerOf();
    const { tab: tabId } = decode('close', raw, schemas.close);
    const tab = pickTab(caller, tabId, true);
    if (openerOf(tab, caller) !== 'you') {
      throw new PaneError('ERR_BROWSER_NOT_YOURS', `Tab ${tab.id} was opened by ${openerOf(tab, caller) === 'person' ? 'the person' : openerOf(tab, caller)}, and agents close only the tabs they opened. Nothing ran.`, 'Leave it open, or ask the person to close it.');
    }
    await gate.run(tab.id, agentName(caller.panelId), paneCommandSignal(), () => host.close(tab));
    holds.forget(tab.id);
    return { ok: true, tab: tab.id };
  });

  tool('snapshot', (raw) => ({ tab: decode('snapshot', raw, schemas.snapshot).tab, request: { verb: 'snapshot' } }));

  tool('screenshot', (raw) => {
    const { tab, fullPage } = decode('screenshot', raw, schemas.screenshot);
    return { tab, request: { verb: 'screenshot', fullPage: fullPage === true } };
  });

  tool('click', (raw) => {
    const { tab, ref, x, y, button, double } = decode('click', raw, schemas.click);
    if (ref === undefined && (x === undefined || y === undefined)) throw invalid('browser_click needs a ref, or both x and y.', 'Pass a ref from browser_snapshot.');
    const request: VerbRequest = { verb: 'click', button: button ?? 'left', double: double === true };
    if (ref !== undefined) request.ref = ref;
    else Object.assign(request, { x, y });
    return { tab, request };
  });

  tool('type', (raw) => {
    const { tab, ref, text, clear, submit } = decode('type', raw, schemas.type);
    return { tab, request: { verb: 'type', ref, text, clear: clear === true, submit: submit === true } };
  });

  tool('press', (raw) => {
    const { tab, key, ref } = decode('press', raw, schemas.press);
    return { tab, request: ref === undefined ? { verb: 'press', key } : { verb: 'press', key, ref } };
  });

  tool('select', (raw) => {
    const { tab, ref, values } = decode('select', raw, schemas.select);
    if (values.length === 0) throw invalid('browser_select needs at least one value.', 'Pass --values with the options to choose.');
    return { tab, request: { verb: 'select', ref, values } };
  });

  tool('scroll', (raw) => {
    const { tab, ref, dx, dy } = decode('scroll', raw, schemas.scroll);
    if (ref === undefined && !dx && !dy) throw invalid('browser_scroll needs a distance (dx or dy) or a ref to scroll into view.', 'Pass --dy 600 to scroll down a screen.');
    return { tab, request: ref === undefined ? { verb: 'scroll', dx: dx ?? 0, dy: dy ?? 0 } : { verb: 'scroll', ref, dx: dx ?? 0, dy: dy ?? 0 } };
  });

  tool('navigate', (raw) => {
    const { tab, url, back, forward, reload } = decode('navigate', raw, schemas.navigate);
    const chosen = [url !== undefined, back === true, forward === true, reload === true].filter(Boolean).length;
    if (chosen !== 1) throw invalid('browser_navigate takes exactly one of url, back, forward or reload.', 'Pass a URL, or one of back, forward or reload.');
    return { tab, request: url !== undefined ? { verb: 'navigate', url: checkedWebUrl(url) } : { verb: 'navigate', history: back ? 'back' : forward ? 'forward' : 'reload' } };
  });

  tool('wait', (raw) => {
    const { tab, text, url, ref, timeoutMs } = decode('wait', raw, schemas.wait);
    if (text === undefined && url === undefined && ref === undefined) throw invalid('browser_wait needs at least one of text, url or ref.', 'Pass --text with what the page should show.');
    const request: VerbRequest = { verb: 'wait', timeoutMs: Math.min(Math.max(timeoutMs ?? WAIT_DEFAULT_MS, 0), WAIT_MAX_MS) };
    if (text !== undefined) request.text = text;
    if (url !== undefined) request.url = url;
    if (ref !== undefined) request.ref = ref;
    return { tab, request };
  });

  tool('dialog', (raw) => {
    const { tab, accept, dismiss, text } = decode('dialog', raw, schemas.dialog);
    if ((accept === true) === (dismiss === true)) throw invalid('browser_dialog takes exactly one of accept or dismiss.', 'Pass --accept to press OK, or --dismiss to press Cancel.');
    return { tab, request: text === undefined ? { verb: 'dialog', accept: accept === true } : { verb: 'dialog', accept: accept === true, text } };
  });

  tool('evaluate', (raw) => {
    const { tab, expression, ref } = decode('evaluate', raw, schemas.evaluate);
    return { tab, request: ref === undefined ? { verb: 'evaluate', expression } : { verb: 'evaluate', expression, ref } };
  });

  tool('upload', (raw, caller) => {
    const { tab, ref, paths } = decode('upload', raw, schemas.upload);
    if (paths.length === 0) throw invalid('browser_upload needs at least one path.', 'Pass --paths with files in your worktree.');
    const files = paths.map(file => checkedUploadPath(caller.worktree, file));
    return { tab, request: ref === undefined ? { verb: 'upload', paths: files } : { verb: 'upload', ref, paths: files } };
  });

  /**
   * The tab's chip: Take over and Hand to agent, from the screen `viewer`. A host channel, so any
   * screen showing the Pane reaches the computer whose page it is. Only Pane's own UI may call it.
   */
  commandRegistry.register('browser:driver', async (panelId: PaneCommandValue, who: PaneCommandValue, viewer?: PaneCommandValue) => {
    if (paneCommandCaller() || teammatePaneCaller()) return { success: false, error: 'This channel belongs to the person\'s browser tab.' };
    const id = decodeOptionalBoundary(panelId, boundary.string);
    if (!id || !host.tab(id) || (who !== 'person' && who !== 'agent')) return { success: false, error: 'That browser tab is gone.' };
    await setDriverFromChip(id, who, decodeOptionalBoundary(viewer, boundary.string));
    return { success: true };
  });

  /**
   * A screen showing a tab says so every few seconds, with the space it gives the page, and says
   * when it stops (`report` null). The tab's page stays alive here while any screen shows it and
   * for the grace time after. A host channel, so another desktop, the PWA and the phone reach it.
   */
  commandRegistry.register('browser:watch', async (panelId: PaneCommandValue, viewer: PaneCommandValue, report: PaneCommandValue) => {
    if (paneCommandCaller() || teammatePaneCaller()) return { success: false, error: 'This channel belongs to the person\'s screens.' };
    const id = decodeOptionalBoundary(panelId, boundary.string);
    const viewerId = decodeOptionalBoundary(viewer, boundary.nonEmptyString);
    if (!id || !viewerId || !host.tab(id)) return { success: false, error: 'That browser tab is gone.' };
    let decoded;
    try {
      decoded = decodeBoundary(report ?? undefined, watchReportSchema);
    } catch (cause) {
      return { success: false, error: `The watch report is malformed: ${reasonOf(cause)}.` };
    }
    if (!decoded) {
      holds.unwatch(id, viewerId);
    } else {
      // This computer's own window is the host's screen, whatever it calls itself.
      const kind: ViewerKind = isRemotePaneCommand() ? decoded.kind : 'host';
      holds.watch(id, viewerId, { ...decoded, kind });
    }
    applyWatch(id);
    return { success: true };
  });

  // ── Streaming the page to other screens (S2) ──

  /** Each live page viewers read frames of: its newest frame, the reads waiting for the next, and the last read. */
  interface Stream { driver: PageDriver; frame?: BrowserFrame; waiters: Set<() => void>; lastRead: number }
  const streams = new Map<number, Stream>();
  let frameSeq = 0;

  /** The frame size the screens watching from afar need: the largest of them, in device pixels. */
  function settingsFor(tabId: string): ScreencastSettings {
    const far = holds.viewers(tabId).filter(viewer => viewer.kind !== 'host');
    const maxWidth = Math.round(Math.max(320, ...far.map(viewer => viewer.width * Math.min(viewer.scale ?? 1, 3))));
    const maxHeight = Math.round(Math.max(320, ...far.map(viewer => viewer.height * Math.min(viewer.scale ?? 1, 3))));
    return { maxWidth, maxHeight, quality: FRAME_QUALITY };
  }

  function streamOf(tabId: string, page: BrowserPageContents): Stream {
    let stream = streams.get(page.id);
    const driver = driverFor(tabId, page);
    if (!stream) {
      const created: Stream = { driver, waiters: new Set(), lastRead: Date.now() };
      stream = created;
      streams.set(page.id, created);
      page.once('destroyed', () => { streams.delete(page.id); for (const wake of created.waiters) wake(); });
    }
    const current = stream;
    void driver.startScreencast(settingsFor(tabId), frame => {
      frameSeq += 1;
      current.frame = { seq: frameSeq, data: `data:image/jpeg;base64,${frame.data}`, width: frame.width, height: frame.height };
      for (const wake of current.waiters) wake();
    }).catch(cause => console.warn(`[browser] Could not stream tab ${tabId}:`, cause));
    return stream;
  }

  /** Waits until `ready()` holds or `ms` pass; `waiters` wakes it early. */
  function waitFor(waiters: Set<() => void>, ms: number, ready: () => boolean): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise(resolve => {
      const wake = () => { if (!ready()) return; done(); };
      const done = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
      const timer = setTimeout(done, ms);
      waiters.add(wake);
    });
  }

  /**
   * The tab's newest frame after `after`, for a screen on another device. A read with nothing newer
   * waits on the host until there is a frame, or answers "unchanged" after about a second, so the
   * frame rate follows the link and a still page costs nothing. A page's first read gets a still.
   */
  commandRegistry.register('browser:frame', async (panelId: PaneCommandValue, _viewer: PaneCommandValue, afterValue: PaneCommandValue): Promise<PaneCommandValue> => {
    if (paneCommandCaller() || teammatePaneCaller()) throw new PaneError('ERR_BROWSER_SCREENS_ONLY', 'This channel belongs to the person\'s screens. Nothing ran.', 'Agents use runpane browser.');
    const id = decodeOptionalBoundary(panelId, boundary.string);
    const after = decodeOptionalBoundary(afterValue, boundary.number) ?? 0;
    if (!id || !host.tab(id)) return answer({ stopped: 'gone' });
    const page = host.page(id);
    if (!page || page.isDestroyed()) {
      if (holds.isAsleep(id)) return answer({ stopped: 'asleep' });
      // Watched a moment ago: the page is still being mounted.
      await new Promise(resolve => setTimeout(resolve, FRAME_WAIT_MS));
      return answer({ unchanged: true, seq: after });
    }
    const stream = streamOf(id, page);
    stream.lastRead = Date.now();
    if (!stream.frame) {
      const still = await stream.driver.still(FRAME_QUALITY).catch(() => undefined);
      if (still && !stream.frame) {
        frameSeq += 1;
        stream.frame = { seq: frameSeq, data: `data:image/jpeg;base64,${still.data}`, width: still.width, height: still.height };
      }
    }
    await waitFor(stream.waiters, FRAME_WAIT_MS, () => (stream.frame?.seq ?? 0) > after || page.isDestroyed());
    const frame = stream.frame;
    if (!frame || frame.seq <= after) return answer({ unchanged: true, seq: after });
    // The screen took this frame: Chromium may paint the next.
    stream.driver.ackFrame();
    return answer({ frame });
  });

  function answer(value: BrowserFrameAnswer): PaneCommandValue {
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * The person's input from another screen, in order. It counts as the person's: it takes over from
   * an agent by the 750 ms rule and revokes the agent's refs, and the page takes that screen's size.
   * An empty batch only takes control.
   */
  commandRegistry.register('browser:input', async (panelId: PaneCommandValue, viewer: PaneCommandValue, batchValue: PaneCommandValue): Promise<PaneCommandValue> => {
    if (paneCommandCaller() || teammatePaneCaller()) throw new PaneError('ERR_BROWSER_SCREENS_ONLY', 'This channel belongs to the person\'s screens. Nothing ran.', 'Agents use runpane browser.');
    const id = decodeOptionalBoundary(panelId, boundary.string);
    const viewerId = decodeOptionalBoundary(viewer, boundary.string);
    let batch: BrowserInput[];
    try {
      batch = decodeBoundary(batchValue, inputSchema);
    } catch (cause) {
      throw new PaneError('ERR_BROWSER_INVALID_REQUEST', `The input is malformed: ${reasonOf(cause)}. Nothing ran.`, 'Update Pane on this screen.');
    }
    const page = id ? host.page(id) : undefined;
    if (!id || !host.tab(id) || !page || page.isDestroyed()) throw new PaneError('ERR_BROWSER_NOT_SHOWING', 'That tab has no live page on this computer now, so the input went nowhere.', 'Show the tab again; its page wakes and loads.');
    const driver = driverFor(id, page);
    driver.notePersonInput();
    await personTouched(id, page.id);
    if (viewerId) await takeControl(id, viewerId);
    const files = batch.flatMap(input => (input.kind === 'files' ? input.files : []));
    const bytes = files.reduce((sum, file) => sum + Math.floor(file.data.length * 3 / 4), 0);
    if (bytes > PERSON_UPLOAD_BYTES) throw new PaneError('ERR_BROWSER_UPLOAD_TOO_LARGE', `The files come to ${(bytes / 1_048_576).toFixed(1)} MB, and a page takes up to ${PERSON_UPLOAD_BYTES / 1_048_576} MB from another screen at once. Nothing was sent.`, 'Choose smaller files, or upload them on the computer that runs the tab.');
    const result = await driver.personInput(batch);
    if (files.length) {
      const folder = await host.uploadsFor(page);
      const paths: string[] = [];
      for (const file of files) {
        const target = unusedPath(folder, path.basename(file.name.replace(/\\/g, '/')) || 'file');
        await writeFile(target, Buffer.from(file.data, 'base64'));
        paths.push(target);
      }
      await driver.setChooserFiles(paths);
    }
    changedView(id);
    return JSON.parse(JSON.stringify(result));
  });

  /** Each tab's state version and the reads waiting for it to change. */
  const views = new Map<string, { version: number; waiters: Set<() => void>; pages: Set<number> }>();
  /** Where an agent last clicked in each tab, for the cursor other screens draw. */
  const agentCursors = new Map<string, { x: number; y: number; at: number }>();
  /** The pointer each tab's page shows (a hand over a link). */
  const pointers = new Map<string, string>();
  /** Downloads that saved on this computer, by tab, for other screens' notices. */
  const tabDownloads = new Map<string, Array<{ name: string; at: number; agent?: string }>>();

  function viewOf(tabId: string) {
    let view = views.get(tabId);
    if (!view) {
      view = { version: 1, waiters: new Set(), pages: new Set() };
      views.set(tabId, view);
    }
    return view;
  }

  function changedView(tabId: string): void {
    const view = views.get(tabId);
    if (!view) return;
    view.version += 1;
    for (const wake of view.waiters) wake();
  }

  function showDownload(tabId: string, file: string, agent?: string): void {
    host.showDownload(tabId, file, agent);
    const saved: BrowserTabView['downloads'][number] = { name: path.basename(file), at: Date.now() };
    if (agent) saved.agent = agent;
    const shown = [...(tabDownloads.get(tabId) ?? []), saved].slice(-3);
    tabDownloads.set(tabId, shown);
    changedView(tabId);
  }

  /** Hears the page's own changes (navigation, title, loading, pointer, dialogs) once per page. */
  function followPage(tabId: string, page: BrowserPageContents): void {
    const view = viewOf(tabId);
    if (view.pages.has(page.id)) return;
    view.pages.add(page.id);
    const changed = () => changedView(tabId);
    for (const event of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading'] as const) page.on(event, changed);
    page.on('cursor-changed', (_event, type) => {
      const css = CSS_CURSOR.get(type) ?? type;
      if (pointers.get(tabId) === css) return;
      pointers.set(tabId, css);
      changed();
    });
    page.once('destroyed', () => { view.pages.delete(page.id); changed(); });
    const driver = driverFor(tabId, page);
    driver.onEvent(method => { if (method.startsWith('Page.javascriptDialog') || method === 'Page.fileChooserOpened') changed(); });
    void driver.listen().catch(() => undefined);
  }

  /** A closed tab, as a screen still showing it reads it. */
  function goneView(): PaneCommandValue {
    const view: BrowserTabView = { version: 0, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, pointer: 'default', downloads: [], host: host.name(), stopped: 'gone' };
    return JSON.parse(JSON.stringify(view));
  }

  function tabView(tabId: string, tab: ToolPanel): BrowserTabView {
    const state = tabState(tab);
    const page = host.page(tabId);
    const live = page && !page.isDestroyed() ? page : undefined;
    const driver = live ? pages.get(live.id) : undefined;
    const view: BrowserTabView = {
      version: viewOf(tabId).version,
      url: live?.getURL() || state.currentUrl || '',
      title: live?.getTitle() || tab.title,
      loading: live?.isLoading() ?? false,
      canGoBack: live?.navigationHistory.canGoBack() ?? false,
      canGoForward: live?.navigationHistory.canGoForward() ?? false,
      pointer: pointers.get(tabId) ?? 'default',
      downloads: tabDownloads.get(tabId) ?? [],
      host: host.name(),
    };
    if (state.driver) view.driver = state.driver;
    if (state.pageSize) view.size = state.pageSize;
    const cursor = agentCursors.get(tabId);
    if (cursor) view.agentCursor = cursor;
    if (driver?.pendingDialog) view.dialog = driver.pendingDialog;
    if (driver?.pendingChooser) view.fileChooser = driver.pendingChooser;
    if (!live) view.stopped = holds.isAsleep(tabId) ? 'asleep' : 'gone';
    return view;
  }

  /**
   * The tab as another screen draws it around the stream. A read naming the version it has waits
   * until the state changes, or about 15 seconds.
   */
  commandRegistry.register('browser:view', async (panelId: PaneCommandValue, afterValue: PaneCommandValue): Promise<PaneCommandValue> => {
    if (paneCommandCaller() || teammatePaneCaller()) throw new PaneError('ERR_BROWSER_SCREENS_ONLY', 'This channel belongs to the person\'s screens. Nothing ran.', 'Agents use runpane browser.');
    const id = decodeOptionalBoundary(panelId, boundary.string);
    const after = decodeOptionalBoundary(afterValue, boundary.number) ?? 0;
    const tab = id ? host.tab(id) : undefined;
    if (!id || !tab) return goneView();
    const page = host.page(id);
    if (page && !page.isDestroyed()) followPage(id, page);
    const view = viewOf(id);
    await waitFor(view.waiters, VIEW_WAIT_MS, () => view.version > after || host.tab(id) === undefined);
    const now = host.tab(id);
    return now ? JSON.parse(JSON.stringify(tabView(id, now))) : goneView();
  });

  return () => clearInterval(sweeper);
}

/** `name` in `directory`, or "name (2).ext" and on when a file has it, as browsers name downloads. */
function unusedPath(directory: string, name: string): string {
  const { name: stem, ext } = path.parse(name);
  let file = path.join(directory, name);
  for (let copy = 2; existsSync(file); copy += 1) file = path.join(directory, `${stem} (${copy})${ext}`);
  return file;
}

/** Moves a file, copying it when the folders are on different disks. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (cause) {
    if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'EXDEV') throw cause;
    await copyFile(from, to);
  }
}

/** Agents read and act only on http(s) pages (and a blank one): never a file: or chrome: page in a tab. */
function refuseNonWebPage(contents: BrowserPageContents, verb: 'shows' | 'is now on'): void {
  let protocol = '';
  try { protocol = new URL(contents.getURL()).protocol; } catch { protocol = ''; }
  if (protocol === 'http:' || protocol === 'https:' || contents.getURL() === 'about:blank' || contents.getURL() === '') return;
  throw new PaneError('ERR_BROWSER_URL_REFUSED', `The tab ${verb} a ${protocol || 'non-web'} page, and agents read and act only on http and https pages.${verb === 'is now on' ? ' The call ran; nothing more will on that page.' : ' Nothing ran.'}`, 'Load an http or https page with browser_navigate, or use another tab.');
}

/** Loading a web page is how an agent leaves a file: page, so only the page it lands on is checked. */
function loadsUrl(request: VerbRequest): boolean {
  return request.verb === 'navigate' && request.url !== undefined;
}

function devToolsOpen(contents: BrowserPageContents): boolean {
  return contents.isDevToolsOpened() || (contents.devToolsWebContents !== null && !contents.devToolsWebContents.isDestroyed());
}
