import { createRoot } from 'react-dom/client';
import BrowserPanel from '../../frontend/src/components/panels/browser/BrowserPanel';
import type { ToolPanel } from '../../shared/types/panels';
import type { ListeningPortsSnapshot } from '../../shared/types/listeningPorts';
import type { RemotePaneConnectionState } from '../../shared/types/remoteDaemon';
import { useConfigStore } from '../../frontend/src/stores/configStore';
import type { AppConfig } from '../../frontend/src/types/config';

/** Requests wait for the test's answers; an answer given before its request waits for it. */
function answeredByTest<T>() {
  const answers: T[] = [];
  const requests: Array<(value: T) => void> = [];
  return {
    request: () => new Promise<T>(resolve => {
      const answer = answers.shift();
      if (answer !== undefined) resolve(answer);
      else requests.push(resolve);
    }),
    answer: (value: T) => {
      const request = requests.shift();
      if (request) request(value);
      else answers.push(value);
    },
  };
}

export interface PortsTest {
  answerPortsList(snapshot: ListeningPortsSnapshot): void;
  answerConnectionState(mode: 'local' | 'remote'): void;
  /** Delivers a `ports:changed` event. */
  emitPorts(snapshot: ListeningPortsSnapshot): void;
  /** Loads the app config, which says whether this desktop is connected to a remote host. */
  loadConfig(mode: 'local' | 'remote'): void;
  /** URLs handed to the OS browser, in order. */
  openedExternally: string[];
  /** Local pages handed to the OS browser, in order. */
  openedLocally: string[];
  /** The error the next `openExternal` call fails with; null succeeds. */
  openExternalError: string | null;
  /** When set, `openLocalPage` answers only once this is called, as a slow copy from the host does. */
  finishLocalOpen: (() => void) | null;
  /** Makes the next `openLocalPage` calls wait for `finishLocalOpen`. */
  holdLocalOpens(): void;
  /** Whether the panel listens for this event on this `<webview>` now. */
  listensTo(webview: Element, type: string): boolean;
}

declare global {
  interface Window {
    portsTest: PortsTest;
  }
}

// The panel listens to its <webview> from an effect that runs a task after the element mounts.
const webviewListeners = new WeakMap<EventTarget, Map<string, number>>();
const { addEventListener, removeEventListener } = EventTarget.prototype;
const countListener = (target: EventTarget, type: string, change: number) => {
  if (!(target instanceof Element) || target.localName !== 'webview') return;
  const counts = webviewListeners.get(target) ?? new Map<string, number>();
  counts.set(type, (counts.get(type) ?? 0) + change);
  webviewListeners.set(target, counts);
};
EventTarget.prototype.addEventListener = function (this: EventTarget, ...args: Parameters<EventTarget['addEventListener']>) {
  countListener(this, args[0], 1);
  addEventListener.apply(this, args);
};
EventTarget.prototype.removeEventListener = function (this: EventTarget, ...args: Parameters<EventTarget['removeEventListener']>) {
  countListener(this, args[0], -1);
  removeEventListener.apply(this, args);
};

const portLists = answeredByTest<ListeningPortsSnapshot>();
const connectionStates = answeredByTest<RemotePaneConnectionState>();
let emitPorts: (snapshot: ListeningPortsSnapshot) => void = () => {};
let localOpenHeld = false;

const portsTest: PortsTest = {
  answerPortsList: portLists.answer,
  answerConnectionState: mode => connectionStates.answer({
    mode, status: mode === 'remote' ? 'connected' : 'local', activeProfileId: null, activeProfileLabel: null,
    activeBaseUrl: null, lastError: null, lastSeenAt: null,
  }),
  emitPorts: snapshot => emitPorts(snapshot),
  loadConfig: mode => useConfigStore.setState({
    // SAFETY: the panel reads only the remote client mode from the config.
    config: { remoteDaemon: { client: { mode } } } as AppConfig,
  }),
  openedExternally: [],
  openedLocally: [],
  openExternalError: null,
  finishLocalOpen: null,
  holdLocalOpens: () => { localOpenHeld = true; },
  listensTo: (webview, type) => (webviewListeners.get(webview)?.get(type) ?? 0) > 0,
};

Object.assign(window, {
  portsTest,
  electronAPI: {
    openExternal: async (target: string) => {
      portsTest.openedExternally.push(target);
      return portsTest.openExternalError === null ? { success: true } : { success: false, error: portsTest.openExternalError };
    },
    openLocalPage: async (fileUrl: string, panelId?: string) => {
      portsTest.openedLocally.push(panelId === undefined ? fileUrl : `${fileUrl} ${panelId}`);
      if (localOpenHeld) await new Promise<void>(resolve => { portsTest.finishLocalOpen = resolve; });
      return { success: true };
    },
    invoke: (channel: string) => {
      if (channel === 'ports:list') return portLists.request();
      // This computer is the host, so a file page reads its own disk.
      if (channel === 'browser-panel:prepare-file') return Promise.resolve({ partition: null });
      return Promise.resolve(undefined);
    },
    events: {
      onListeningPortsChanged: (callback: typeof emitPorts) => {
        emitPorts = callback;
        return () => {};
      },
      onRemoteDaemonResyncRequested: () => () => {},
    },
    remoteDaemon: {
      getConnectionState: async () => ({ success: true, data: await connectionStates.request() }),
      // Host state waits on slow executable-health checks; it never answers here.
      getHostState: () => new Promise(() => {}),
      onConnectionStateChanged: () => () => {},
      onHostStateChanged: () => () => {},
    },
  },
});

const url = new URLSearchParams(location.hash.slice(1)).get('url') ?? '';
const panel: ToolPanel = {
  id: 'browser-1',
  sessionId: 'session-1',
  type: 'browser',
  title: 'Browser',
  state: { isActive: true, customState: { currentUrl: url } },
  metadata: { createdAt: '', lastActiveAt: '', position: 0 },
};
createRoot(document.getElementById('root')!).render(<BrowserPanel panel={panel} isActive />);
