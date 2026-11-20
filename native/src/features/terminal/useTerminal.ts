import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { WebView, WebViewMessageEvent } from 'react-native-webview';

import { CONNECTION_GRACE_MS } from '@shared/remoteClient';

import { invokeChannel, useDaemon, useDaemonEvent } from '@/daemon';
import { useTheme } from '@/theme';

import { connectionMark, perfMark } from '../perf/perfMarks';

import { parsePageEvent, type TerminalCommand } from './bridge';
import { TerminalSession, type TerminalSize } from './terminalSession';
import { lastTerminalSize, rememberTerminalSize } from './terminalSize';

const FONT_SIZE = 12;
/** The host forgets viewers after a few minutes; the web app re-announces every minute too. */
const VISIBILITY_REFRESH_MS = 60_000;
/** Keyboard and rotation animations resize the view every frame; tell the PTY once it settles. */
const RESIZE_SETTLE_MS = 150;
/** The computer says an agent is ready when it first draws, or after 10 s regardless. */
const AGENT_READY_LIMIT_MS = 12_000;
/** How many terminals keep their last screen for a revisit. */
const KEPT_SCREENS = 20;

/** Each terminal's last visible rows this run, by computer and panel, the most recently seen last. */
const keptScreens = new Map<string, string>();

function keepScreen(key: string, text: string): void {
  keptScreens.delete(key);
  keptScreens.set(key, text);
  for (const oldest of keptScreens.keys()) {
    if (keptScreens.size <= KEPT_SCREENS) break;
    keptScreens.delete(oldest);
  }
}

export type TerminalStatus = 'loading' | 'ready' | 'error';

/**
 * Connects one terminal panel to the xterm WebView. Render the WebView with
 * `key={panelId}` so switching tabs starts a fresh terminal.
 */
export function useTerminal(panelId: string, sessionId: string) {
  const { client, connection, profile } = useDaemon();
  const screenKey = `${profile.id}:${panelId}`;
  // The rows this terminal showed last time it was open, painted until its screen is read again.
  const [keptScreen] = useState(() => keptScreens.get(screenKey) ?? null);
  // Set when this screen starts the panel: its agent is launching until the computer says it's ready.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [agentReady, setAgentReady] = useState(false);
  const theme = useTheme();
  const webView = useRef<WebView>(null);
  const [status, setStatus] = useState<TerminalStatus>('loading');
  const [error, setError] = useState<unknown>(null);
  // Whether the page shows a screen from the host, which stays up while it reloads.
  const [hasContent, setHasContent] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [screenText, setScreenText] = useState('');
  // Starts from the size the last page measured, so the screen is read while this page loads.
  const [size, setSize] = useState<TerminalSize | null>(lastTerminalSize);
  // The page can take commands; until then a screen read waits here, and output after it waits in `pending`.
  const pageReady = useRef(false);
  const pageLoads = useRef(0);
  const pendingScreen = useRef<string | null>(null);

  // Output arrives in bursts of small events; hand it to xterm once per frame.
  const pending = useRef('');
  const connectionWait = useRef<Promise<void> | null>(null);
  const frame = useRef<number | null>(null);

  const send = (command: TerminalCommand) => {
    if (!pageReady.current) return;
    webView.current?.injectJavaScript(`window.paneTerminal.receive(${JSON.stringify(command)});true;`);
  };
  const flush = () => {
    frame.current = null;
    if (!pending.current || !pageReady.current) return;
    send({ type: 'write', data: pending.current });
    pending.current = '';
  };

  /** Draws a screen read from the host: the terminal now matches the computer. */
  const showScreen = (data: string) => {
    send({ type: 'reset', data });
    // A screen read after a return, open or switch.
    connectionMark('terminal-screen', { repeat: true });
    perfMark('terminal', 'screen', { repeat: true });
    setHasContent(true);
    setStatus('ready');
    setError(null);
  };

  const [session] = useState(() => new TerminalSession({
    invoke: (channel, args) => client.invoke(channel, args),
    panelId,
    sessionId,
    viewerId: `pane-native-${Math.random().toString(36).slice(2)}`,
    sink: {
      reset: data => {
        // Output buffered for the old screen is replaced, but the host still needs its ack.
        if (pending.current) session.ack(pending.current.length);
        pending.current = '';
        if (pageReady.current) showScreen(data);
        else pendingScreen.current = data;
      },
      write: data => {
        pending.current += data;
        frame.current ??= requestAnimationFrame(flush);
      },
    },
    onStart: () => setStartedAt(Date.now()),
    onError: cause => {
      // A restore cut short by a reconnect is retried once the connection is back.
      if (client.getState().status !== 'connected') return;
      setError(cause);
      setStatus('error');
    },
  }));

  useDaemonEvent('terminal:output', event => session.receiveOutput(event.args[0]));
  useDaemonEvent('terminal:cliReady', event => {
    if ((event.args[0] as { panelId?: unknown } | undefined)?.panelId !== panelId) return;
    perfMark('terminal', 'agent-ready');
    setAgentReady(true);
  });
  useEffect(() => {
    if (startedAt === null) return undefined;
    const timer = setTimeout(() => setAgentReady(true), AGENT_READY_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [startedAt]);

  const restore = useEffectEvent(() => {
    if (size) void session.restore(size);
  });

  useEffect(() => client.onRestore(async signal => {
    if (!signal.aborted && size) await session.restore(size);
  }, 'terminal'), [client, session, size]);

  // Restore once the page has measured itself. A connection that comes back, after a drop or a
  // return to the app, restores through the listener above: the event stream does not replay
  // output missed while away, so the screen is read again once it is open, and only then.
  // A screen opened during another restore (a tab switch right after a return) missed those
  // listeners, so it restores when the connection turns live and it still shows nothing.
  const measured = size !== null;
  useEffect(() => {
    if (!measured) return undefined;
    let status = client.getState().status;
    if (status === 'connected') restore();
    return client.onStatus(state => {
      if (state.status === 'connected' && status !== 'connected' && !session.isLive) restore();
      status = state.status;
    });
  }, [measured, client, session]);

  useEffect(() => {
    const keepAlive = setInterval(() => session.keepAlive(), VISIBILITY_REFRESH_MS);
    // Only a real trip to the background detaches. Notification Center, Face ID and permission
    // prompts pass through 'inactive' and leave the screen live. The client reconnects on return,
    // and its restore listener reads the screen again.
    const appState = AppState.addEventListener('change', state => {
      if (state === 'background') session.detach();
    });
    return () => {
      clearInterval(keepAlive);
      appState.remove();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      session.detach();
    };
  }, [session]);

  // Settle resizes before telling the host.
  useEffect(() => {
    if (!size || status !== 'ready') return;
    const timer = setTimeout(() => session.resize(size), RESIZE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [session, size, status]);

  const themeCommand: TerminalCommand = { type: 'theme', theme: theme.terminal, fontSize: FONT_SIZE };
  const themeJson = JSON.stringify(themeCommand);
  useEffect(() => {
    webView.current?.injectJavaScript(`window.paneTerminal&&window.paneTerminal.receive(${themeJson});true;`);
  }, [themeJson]);

  const onMessage = (event: WebViewMessageEvent) => {
    const message = parsePageEvent(event.nativeEvent.data);
    if (!message) return;
    switch (message.type) {
      case 'ready': {
        pageReady.current = true;
        send(themeCommand);
        const next = { cols: message.cols, rows: message.rows };
        rememberTerminalSize(next);
        if (++pageLoads.current > 1) {
          // A page that loads again (after iOS reclaimed it) starts blank.
          pendingScreen.current = null;
          setHasContent(false);
          if (size && connection.status === 'connected') {
            setStatus('loading');
            void session.restore(next);
          }
        } else if (pendingScreen.current !== null) {
          // The screen was read while this page loaded; output after it follows.
          showScreen(pendingScreen.current);
          pendingScreen.current = null;
          flush();
        }
        setSize(next);
        break;
      }
      case 'resize':
        setSize(current => current?.cols === message.cols && current.rows === message.rows
          ? current
          : { cols: message.cols, rows: message.rows });
        break;
      case 'input':
        // The page only generates input: replies to the agent's terminal queries and
        // scroll reports. One that cannot be sent while reconnecting is dropped; a
        // broken connection shows in the header, not over the terminal.
        void session.sendInput(message.data).catch(() => undefined);
        break;
      case 'written':
        session.ack(message.units);
        break;
      case 'scrolled':
        setAtBottom(message.atBottom);
        break;
      case 'screen':
        setScreenText(message.text);
        keepScreen(screenKey, message.text);
        break;
    }
  };

  return {
    webView,
    onMessage,
    /** iOS may reclaim the page's process under memory pressure; load it again. */
    reload: () => {
      session.detach();
      pageReady.current = false;
      webView.current?.reload();
    },
    status,
    hasContent,
    keptScreen,
    /** This screen started an agent's panel and the agent hasn't drawn yet (up to 12 s). */
    agentStarting: startedAt !== null && !agentReady,
    error,
    atBottom,
    screenText,
    rows: size?.rows ?? 0,
    retry: () => {
      setStatus('loading');
      if (size) void session.restore(size);
    },
    // Typed while the connection comes back: wait for it, up to the grace window, then send once.
    // Keys typed meanwhile share one wait, so they all go out in order or none do.
    sendInput: (data: string) => {
      const wait = connectionWait.current ??= client.whenConnected(CONNECTION_GRACE_MS).finally(() => { connectionWait.current = null; });
      return wait.then(() => session.sendInput(data));
    },
    /** Clears the scrollback on the host, then redraws the screen from the host's copy. */
    clearScrollback: async () => {
      await invokeChannel(client, 'terminal:clearScrollback', [panelId]);
      if (size) await session.restore(size);
    },
    scrollLines: (lines: number) => send({ type: 'scroll', lines }),
    scrollToBottom: () => send({ type: 'scrollToBottom' }),
  };
}
