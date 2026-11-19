import { existsSync, mkdirSync, realpathSync, statSync } from 'fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import os from 'os';
import { randomUUID } from 'crypto';
import path from 'path';
import { PaneError, reasonOf } from '../../../shared/paneError';
import type { BrowserPanelState, ToolPanel } from '../../../shared/types/panels';
import type { DeviceDriver } from '../../../shared/types/devices';
import { DEFAULT_BROWSER_SETTINGS, type BrowserSettings } from '../../../shared/types/browser';
import { agentLabel } from '../../../shared/agents';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema, type JsonObject, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import { isRemotePaneCommand, paneCommandCaller, paneCommandSignal, teammatePaneCaller, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { DeviceDriverGate } from '../services/devices/deviceDriverGate';
import { PageDriver, WAIT_DEFAULT_MS, WAIT_MAX_MS, type BrowserPageContents, type FileChooser, type PendingDialog } from '../services/browser/pageDriver';
import { READ_VERBS, runVerb, type VerbOutcome, type VerbRequest } from '../services/browser/pageVerbs';
import { BROWSER_MACHINE_CHANNEL, IMAGE_CHUNK_BYTES, linkedBrowserRequestSchema, linkedChunkAnswerSchema, linkedProbeAnswerSchema, linkedRunAnswerSchema } from '../services/browser/linkedBrowser';
import { answerWithin, awaitTask } from './macDevices';
import { BrowserHolds } from '../services/browser/browserHolds';
import { loopbackPortOf, remapLoopbackPort } from '../../../shared/utils/browserUrl';

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
  /** On a desktop showing another computer's Pane: the tab's local tunnel ports and the host ports they reach. */
  tunnels(panelId: string): ReadonlyMap<number, number>;
  /** Whether this Pane has a window that can show a tab (headless hosts have none). */
  hasWindow(): boolean;
  /** Where a Pane's screenshots go: its scratch folder, deleted with the Pane. */
  shotsDirectory(paneId: string): Promise<string>;
  /** Shows the agent's cursor where it clicked, in the tab. */
  showCursor(panelId: string, x: number, y: number): void;
  /** The tabs agents hold: their pages stay alive while hidden (P4). */
  setHeld(tabIds: readonly string[]): void;
  /** Hears a tab closing for good or a Pane archived: agents whose tab is gone stop holding pages. */
  onGone(listener: () => void): void;
  /** A call runs on the tab: a hidden page paints while it does, so screenshots are current. */
  setBusy(panelId: string, busy: boolean): void;
  /** Your other computers this one is linked to, when it keeps connections to them (P2). */
  linked(): LinkedComputers | undefined;
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

/** The linked computers an agent's call can reach, and how this computer names itself to them. */
export interface LinkedComputers {
  self: { id: string; name: string };
  /** The linked computers online now. */
  online(): Array<{ id: string; name: string }>;
  invoke(machineId: string, request: JsonObject, timeoutMs: number): Promise<PaneCommandValue>;
}

/** One tab as browser_tabs lists it (the contract's browserTab). */
interface TabSummary { id: string; url: string; title: string; openedBy: string; yours: boolean; driving?: string; showing: boolean; held: boolean; asleep: boolean; dialog?: PendingDialog; downloads?: string[] }
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
/** How long a linked computer has to say whether it shows a tab. */
const PROBE_TIMEOUT_MS = 3_000;
/** A probe that found no linked computer showing the tab holds this long. */
const PROBE_MISS_MS = 10_000;
/** Uploads to a linked computer travel in one request, under its 16 MB body limit once base64-encoded. */
const LINKED_UPLOAD_BYTES = 10 * 1_048_576;
/** Linked-call failures that mean the call never reached that computer, so it is safe to run elsewhere. */
const UNREACHED_CODES = new Set(['ERR_REMOTE_OFFLINE', 'ERR_REMOTE_TRANSPORT', 'ERR_MACHINE_OFFLINE', 'ERR_MACHINE_UNKNOWN']);
/** How long one call to a linked computer may take before it answers with a task. */
const LINKED_CALL_MS = 15_000;
/** How long an agent's call waits for the person to stop using a tab on a linked computer, as the driver gate does here. */
const PERSON_WAIT_MS = 4 * 60_000;
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

/** Holds (P4): how many tabs one agent keeps alive while hidden, and for how long without an action (D-126). */
export interface BrowserHoldSettings { limit: number; idleMs: number; sweepMs: number }
const DEFAULT_HOLDS: BrowserHoldSettings = { limit: 4, idleMs: 15 * 60_000, sweepMs: 30_000 };

/**
 * The browser tools (docs/BROWSER_AGENTS.md): agents read and act on the browser tabs of their own
 * Pane through `runpane:browser:*`. Writes run through the driver gate keyed by tab, so the person
 * sees who drives and can take over; calls on different tabs never wait on each other. Returns what
 * stops the holds' sweep.
 */

export function registerBrowserHandlers(services: BrowserServices, commandRegistry: PaneCommandRegistry, host: BrowserHost, holdSettings: BrowserHoldSettings = DEFAULT_HOLDS): () => void {
  const pages = new Map<number, PageDriver>();
  const holds = new BrowserHolds({ limit: holdSettings.limit, idleMs: holdSettings.idleMs, onChange: held => host.setHeld(held) });
  const sweep = () => holds.sweep(
    // An agent is gone once its tab closed or its Pane was archived.
    agent => { const tab = host.tab(agent); return tab !== undefined && services.sessionManager.getSession(tab.sessionId)?.archived !== true; },
    // A dialog waiting for an answer counts as action.
    tabId => { const page = host.page(tabId); return page !== undefined && pages.get(page.id)?.pendingDialog !== undefined; },
    // The person closed the tab: it holds nothing and counts toward no limit.
    tabId => host.tab(tabId) !== undefined,
  );
  const sweeper = setInterval(sweep, holdSettings.sweepMs);
  sweeper.unref?.();
  // Closing the agent's tab or archiving its Pane puts its held tabs to sleep at once.
  host.onGone(sweep);
  /** Linked computers found showing each tab, or found not showing it (machine undefined) until `until`. */
  const viewers = new Map<string, { machine: { id: string; name: string } | undefined; until: number }>();
  /** Tabs the person holds by touching the page; they go back to the agent TOUCH_HOLD_MS after the last touch. */
  const touchTimers = new Map<string, NodeJS.Timeout>();
  /** Tabs the person took over with the chip: they hold them until Hand to agent. */
  const chipHeld = new Set<string>();
  /** When the agent opened each tab: the first moments after, a linked computer may not show it yet. */
  const opened = new Map<string, number>();

  const gate = new DeviceDriverGate({
    kind: 'browser',
    read: (tabId) => { const tab = host.tab(tabId); return tab ? tabState(tab).driver : undefined; },
    write: async (tabId, driver) => { const tab = host.tab(tabId); if (tab) await host.update(tab, { ...tabState(tab), driver }); },
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
      void download.finished.then(done => { if (done && download.tabId) host.showDownload(download.tabId, file); });
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
        host.showDownload(tab.id, file, driver?.by === 'agent' ? driver.agent : 'The agent');
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
      showing: page !== undefined || viewers.get(tab.id)?.machine !== undefined,
      held: holds.isHeld(tab.id),
      // Asleep only while its page is really gone: a tab in view, or one the person reselected, has its page.
      asleep: holds.isAsleep(tab.id) && host.page(tab.id) === undefined,
    };
    if (state.driver) item.driving = state.driver.by === 'person' ? 'person' : state.driver.agent;
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
      if (!host.hasWindow()) {
        throw new PaneError('ERR_BROWSER_NOT_LINKED', `Tab ${tab.id} in ${paneName} did not load its page in a hidden window within ${PAGE_WAIT_MS / 1000} seconds: Pane runs here without a window, and no linked computer shows ${paneName}. Nothing ran.`, `Try again. To drive the copy you watch instead, open ${paneName} in Pane's desktop app on a computer linked in Settings › Your computers (a computer that only views this one over Tailscale or SSH cannot run browser tools).`);
      }
      throw new PaneError('ERR_BROWSER_NOT_SHOWING', `Tab ${tab.id} in ${paneName} did not load its page in Pane's window within ${PAGE_WAIT_MS / 1000} seconds. Nothing ran.`, `Try again. If it fails again, ask the person to open ${paneName} in Pane. To use a tab you watch from another computer, link that computer in Settings › Your computers.`);
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
      if (!driver || driver.isAgentInput()) return;
      // The person changed the page under the agent's refs, so they go stale either way.
      driver.notePersonInput();
      void personTouched(tabId, page.id);
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
    if (who === 'person') chipHeld.add(tabId);
    else chipHeld.delete(tabId);
    clearTimeout(touchTimers.get(tabId));
    touchTimers.delete(tabId);
    const page = host.page(tabId);
    if (who === 'person' && page) pages.get(page.id)?.revokeRefs();
    // Taking over a tab a linked computer shows revokes the refs its copy handed out too.
    const linked = host.linked();
    const viewer = viewers.get(tabId)?.machine;
    if (who === 'person' && linked && viewer) void linked.invoke(viewer.id, { op: 'revoke', from: linked.self, panelId: tabId }, PROBE_TIMEOUT_MS).catch(() => undefined);
    const tab = host.tab(tabId);
    const waiting = tab ? tabState(tab).driver : undefined;
    const driver: DeviceDriver | undefined = who === 'person' ? (waiting?.by === 'person' ? waiting : { by: 'person' }) : undefined;
    await gate.set(tabId, driver);
  }


  /** The linked computer showing the tab, if any: that copy is the one the person watches, so it wins. */
  async function viewerOf(tab: ToolPanel): Promise<{ id: string; name: string } | undefined> {
    const linked = host.linked();
    if (!linked) return undefined;
    const known = viewers.get(tab.id);
    if (known && (known.machine || known.until > Date.now())) return known.machine;
    const online = linked.online();
    const answers = await Promise.all(online.map(async machine => {
      try {
        const answer = decodeBoundary(await linked.invoke(machine.id, { op: 'probe', from: linked.self, panelId: tab.id }, PROBE_TIMEOUT_MS), linkedProbeAnswerSchema);
        return answer.showing ? machine : undefined;
      } catch {
        return undefined;
      }
    }));
    const machine = answers.find(found => found !== undefined);
    // A tab opened a moment ago may not have reached the linked computer's window yet, so a miss is not kept.
    const fresh = Date.now() - (opened.get(tab.id) ?? 0) < PROBE_MISS_MS;
    if (machine || !fresh) viewers.set(tab.id, { machine, until: Date.now() + PROBE_MISS_MS });
    return machine;
  }

  /** Runs a verb on the copy of the tab a linked computer shows, waiting while the person drives there. */
  async function runLinked(linked: LinkedComputers, machine: { id: string; name: string }, tab: ToolPanel, request: VerbRequest, agent: string): Promise<VerbOutcome> {
    let files: { name: string; data: string }[] | undefined;
    if (request.verb === 'upload') {
      const sizes = await Promise.all(request.paths.map(async file => (await stat(file)).size));
      const total = sizes.reduce((sum, size) => sum + size, 0);
      if (total > LINKED_UPLOAD_BYTES) {
        throw new PaneError('ERR_BROWSER_UPLOAD_TOO_LARGE', `The files come to ${(total / 1_048_576).toFixed(1)} MB, and a tab shown on another computer takes uploads up to ${LINKED_UPLOAD_BYTES / 1_048_576} MB in one call. Nothing ran.`, 'Upload fewer or smaller files, or open the Pane on this computer and upload there.');
      }
      files = await Promise.all(request.paths.map(async file => ({ name: path.basename(file), data: (await readFile(file)).toString('base64') })));
    }
    const deadline = Date.now() + PERSON_WAIT_MS;
    // Set while the person's touches on that computer hold the tab; a Take over in the chip is theirs to end.
    let heldByTouch = false;
    try {
      return await runLinkedLoop();
    } finally {
      if (heldByTouch && !chipHeld.has(tab.id) && tabState(tab).driver?.by === 'person') await gate.set(tab.id, { by: 'agent', agent });
    }

    async function runLinkedLoop(): Promise<VerbOutcome> {
    for (;;) {
      // Take over pressed while the call waited on the person's touches: it waits for Hand to agent.
      if (chipHeld.has(tab.id)) {
        if (Date.now() >= deadline) {
          throw new PaneError('ERR_BROWSER_PERSON_DRIVING', `The person took over this tab on ${machine.name} and has not handed it back in ${PERSON_WAIT_MS / 60_000} minutes. Nothing ran.`, 'Ask them to hand the tab back, then try again.');
        }
        await new Promise(resolve => setTimeout(resolve, 250));
        continue;
      }
      const message: JsonObject = { op: 'run', from: linked.self, panelId: tab.id, request };
      if (files) message.files = files;
      let answer = decodeBoundary(await linked.invoke(machine.id, message, LINKED_CALL_MS), linkedRunAnswerSchema);
      while ('pending' in answer) answer = decodeBoundary(await linked.invoke(machine.id, { op: 'await', from: linked.self, task: answer.pending }, LINKED_CALL_MS), linkedRunAnswerSchema);
      if ('outcome' in answer) {
        const { image, ...rest } = answer.outcome;
        const outcome: VerbOutcome = { ...rest };
        if (image) outcome.image = { png: await fetchImage(linked, machine, image.id, image.size), width: image.width, height: image.height };
        return outcome;
      }
      // The person is using the page on that computer: they drive until they stop.
      if (Date.now() >= deadline) {
        throw new PaneError('ERR_BROWSER_PERSON_DRIVING', `The person has been using this tab on ${machine.name} for ${PERSON_WAIT_MS / 60_000} minutes. Nothing ran.`, 'Ask them to stop using the page, then try again.');
      }
      if (tabState(tab).driver?.by !== 'person') {
        heldByTouch = true;
        await gate.set(tab.id, { by: 'person', agentWaiting: agent });
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    }
  }

  async function fetchImage(linked: LinkedComputers, machine: { id: string; name: string }, id: string, size: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < size;) {
      const chunk = decodeBoundary(await linked.invoke(machine.id, { op: 'chunk', from: linked.self, image: id, offset }, LINKED_CALL_MS), linkedChunkAnswerSchema);
      const bytes = Buffer.from(chunk.data, 'base64');
      parts.push(bytes);
      offset += bytes.length;
      if (chunk.done || bytes.length === 0) break;
    }
    return Buffer.concat(parts);
  }

  /**
   * Runs a verb on this computer's page for the tab. The agent holds the tab here only: a call that
   * runs on a linked computer's copy leaves this computer's copy asleep.
   */
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
    if (outcome.cursor) host.showCursor(tab.id, outcome.cursor.x, outcome.cursor.y);
    return outcome;
  }

  /**
   * Runs a verb on a tab: on the copy a linked computer shows when one does, else on this
   * computer's. Reads go straight through; writes wait their turn behind the person.
   */
  async function onTab(caller: BrowserCaller, tab: ToolPanel, request: VerbRequest): Promise<VerbOutcome> {
    const write = !READ_VERBS.has(request.verb);
    const agent = agentName(caller.panelId);
    const run = async (): Promise<VerbOutcome> => {
      const linked = host.linked();
      const machine = await viewerOf(tab);
      if (linked && machine) {
        try {
          return await runLinked(linked, machine, tab, request, agent);
        } catch (cause) {
          const code = cause instanceof PaneError ? cause.code : '';
          // Whatever went wrong there, the next call asks the linked computers again.
          viewers.delete(tab.id);
          if (code === 'ERR_BROWSER_NOT_SHOWING') {
            // That computer stopped showing the tab: use whichever copy shows it now.
            const next = await viewerOf(tab);
            if (next) return runLinked(linked, next, tab, request, agent);
          } else if (!UNREACHED_CODES.has(code)) {
            // The call may have run there, so it is not repeated here.
            throw cause;
          }
        }
      }
      return runLocal(tab, request, write, caller.panelId ?? caller.paneId);
    };
    return write ? gate.run(tab.id, agent, paneCommandSignal(), run) : run();
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
   * A new tab's page registers a moment after the tab opens, here or on a linked computer. Returns
   * once it registered: a page still loading after WAIT_DEFAULT_MS comes back as it is.
   */
  async function waitForTab(caller: BrowserCaller, tab: ToolPanel): Promise<VerbOutcome> {
    opened.set(tab.id, Date.now());
    const deadline = Date.now() + PAGE_WAIT_MS;
    // A linked computer showing the tab wins over this computer's copy, so look there first.
    while (host.linked() && !host.page(tab.id) && Date.now() < deadline) {
      if (await viewerOf(tab)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
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
    viewers.delete(tab.id);
    holds.forget(tab.id);
    opened.delete(tab.id);
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

  /** Screenshots a linked computer took, held until the agent's computer fetches them. */
  const images = new Map<string, { data: Buffer; expires: number }>();

  /**
   * This computer's copies of tabs for your other computers' agents (`runpane:machine:browser`,
   * P2). The tab and its checks are the agent's computer's; this side only runs the verb on the
   * page it shows, with its own page driver, and says when the person is using that page.
   */
  commandRegistry.register(BROWSER_MACHINE_CHANNEL, async (raw: PaneCommandValue) => {
    if (!isRemotePaneCommand() || teammatePaneCaller()) {
      throw new PaneError('ERR_BROWSER_LINKED_ONLY', 'This channel answers only the owner\'s linked computers. Nothing ran.', 'Agents use runpane browser from a Pane tab.');
    }
    const message = decodeBoundary(raw, linkedBrowserRequestSchema);
    const key = `${message.from.id}:browser`;
    if (message.op === 'probe') return { showing: host.page(message.panelId) !== undefined };
    if (message.op === 'revoke') {
      const page = host.page(message.panelId);
      if (page) pages.get(page.id)?.revokeRefs();
      return { ok: true };
    }
    if (message.op === 'await') return awaitTask(key, message.task, () => new PaneError('ERR_BROWSER_TASK_GONE', `This computer no longer has that browser call from ${message.from.name}.`, 'Call the browser tool again.'));
    if (message.op === 'chunk') {
      const image = images.get(message.image);
      if (!image) throw new PaneError('ERR_BROWSER_TASK_GONE', 'This computer no longer has that screenshot.', 'Take the screenshot again.');
      const data = image.data.subarray(message.offset, message.offset + IMAGE_CHUNK_BYTES);
      const done = message.offset + data.length >= image.data.length;
      if (done) images.delete(message.image);
      return { data: data.toString('base64'), done };
    }
    const contents = host.page(message.panelId);
    if (!contents) throw new PaneError('ERR_BROWSER_NOT_SHOWING', 'This computer no longer shows that tab. Nothing ran.', 'Call the browser tool again.');
    const write = !READ_VERBS.has(message.request.verb);
    if (write && devToolsOpen(contents)) {
      throw new PaneError('ERR_BROWSER_DEVTOOLS_OPEN', 'DevTools is open on that tab, and agents don\'t act on a page while the person inspects it. Nothing ran.', 'Ask the person to close DevTools on that tab, then try again.');
    }
    if (!loadsUrl(message.request)) refuseNonWebPage(contents, 'shows');
    const driver = driverFor(message.panelId, contents);
    if (write && driver.personDriving(TOUCH_HOLD_MS)) return { personDriving: true };
    return answerWithin(key, (async () => {
      // This desktop reaches the host's localhost ports through tunnels on other local ports.
      const tunnels = host.tunnels(message.panelId);
      const hostToLocal = new Map([...tunnels].map(([local, hostPort]) => [hostPort, local]));
      const hostPort = message.request.verb === 'navigate' && message.request.url !== undefined ? loopbackPortOf(message.request.url) : null;
      // A host port with no tunnel here would load this computer's own service in its place.
      if (hostPort !== null && !hostToLocal.has(hostPort)) {
        throw new PaneError('ERR_BROWSER_URL_REFUSED', `Port ${hostPort} on the agent's computer has no tunnel on the computer showing this tab, so its localhost is not the agent's. Nothing ran.`, `Forward port ${hostPort} from the tab's Ports list on that computer, then try again.`);
      }
      let request = message.request.verb === 'navigate' && message.request.url !== undefined
        ? { ...message.request, url: remapLoopbackPort(message.request.url, hostToLocal) }
        : message.request;
      let uploads: string | undefined;
      if (request.verb === 'upload' && message.files) {
        uploads = await mkdtemp(path.join(os.tmpdir(), 'pane-browser-upload-'));
        const paths: string[] = [];
        for (const file of message.files) {
          const target = path.join(uploads, path.basename(file.name));
          await writeFile(target, Buffer.from(file.data, 'base64'));
          paths.push(target);
        }
        request = { ...request, paths };
      }
      try {
        const { image, cursor, ...rest } = await runVerb(driver, contents, request);
        refuseNonWebPage(contents, 'is now on');
        if (cursor) host.showCursor(message.panelId, cursor.x, cursor.y);
        const outcome: PaneCommandValue = { ...rest, url: remapLoopbackPort(rest.url, tunnels) };
        if (image) {
          const id = randomUUID();
          for (const [old, held] of images) if (held.expires < Date.now()) images.delete(old);
          images.set(id, { data: image.png, expires: Date.now() + 5 * 60_000 });
          Object.assign(outcome, { image: { id, size: image.png.length, width: image.width, height: image.height } });
        }
        return { outcome };
      } finally {
        // The page reads an uploaded file when its form submits, so the copy stays until the page goes.
        if (uploads) {
          const folder = uploads;
          contents.once('destroyed', () => { void rm(folder, { recursive: true, force: true }); });
        }
      }
    })());
  });

  /**
   * The tab's chip: Take over and Hand to agent. A host channel, so a desktop showing another
   * computer's Pane reaches the computer whose agent drives. Only Pane's own UI may call it.
   */
  commandRegistry.register('browser:driver', async (panelId: PaneCommandValue, who: PaneCommandValue) => {
    if (paneCommandCaller() || teammatePaneCaller()) return { success: false, error: 'This channel belongs to the person\'s browser tab.' };
    const id = decodeOptionalBoundary(panelId, boundary.string);
    if (!id || !host.tab(id) || (who !== 'person' && who !== 'agent')) return { success: false, error: 'That browser tab is gone.' };
    await setDriverFromChip(id, who);
    return { success: true };
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
