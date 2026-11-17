import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { WebView, WebViewMessageEvent } from 'react-native-webview';

import { CONNECTION_GRACE_MS } from '@shared/remoteClient';

import { invokeChannel, useDaemon, useDaemonEvent } from '@/daemon';
import { useTheme } from '@/theme';

import { connectionMark, perfMark } from '../perf/perfMarks';

import { parsePageEvent, type TerminalCommand } from './bridge';
import { TerminalSession, type TerminalSize } from './terminalSession';

const FONT_SIZE = 12;
/** The host forgets viewers after a few minutes; the web app re-announces every minute too. */
const VISIBILITY_REFRESH_MS = 60_000;
/** Keyboard and rotation animations resize the view every frame; tell the PTY once it settles. */
const RESIZE_SETTLE_MS = 150;

export type TerminalStatus = 'loading' | 'ready' | 'error';

/**
 * Connects one terminal panel to the xterm WebView. Render the WebView with
 * `key={panelId}` so switching tabs starts a fresh terminal.
 */
export function useTerminal(panelId: string, sessionId: string) {
  const { client, connection } = useDaemon();
  const theme = useTheme();
  const webView = useRef<WebView>(null);
  const [status, setStatus] = useState<TerminalStatus>('loading');
  const [error, setError] = useState<unknown>(null);
  // Whether the page shows a screen from the host, which stays up while it reloads.
  const [hasContent, setHasContent] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [screenText, setScreenText] = useState('');
  const [size, setSize] = useState<TerminalSize | null>(null);

  // Output arrives in bursts of small events; hand it to xterm once per frame.
  const pending = useRef('');
  const connectionWait = useRef<Promise<void> | null>(null);
  const frame = useRef<number | null>(null);

  const send = (command: TerminalCommand) => {
    webView.current?.injectJavaScript(`window.paneTerminal.receive(${JSON.stringify(command)});true;`);
  };
  const flush = () => {
    frame.current = null;
    if (!pending.current) return;
    send({ type: 'write', data: pending.current });
    pending.current = '';
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
        send({ type: 'reset', data });
        // A screen read after a return, open or switch: the terminal now matches the computer.
        connectionMark('terminal-screen', { repeat: true });
        perfMark('terminal', 'screen', { repeat: true });
        setHasContent(true);
        setStatus('ready');
        setError(null);
      },
      write: data => {
        pending.current += data;
        frame.current ??= requestAnimationFrame(flush);
      },
    },
    onError: cause => {
      // A restore cut short by a reconnect is retried once the connection is back.
      if (client.getState().status !== 'connected') return;
      setError(cause);
      setStatus('error');
    },
  }));

  useDaemonEvent('terminal:output', event => session.receiveOutput(event.args[0]));

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
        send(themeCommand);
        const next = { cols: message.cols, rows: message.rows };
        // A page that loads again (after iOS reclaimed it) starts blank.
        setHasContent(false);
        if (size && connection.status === 'connected') {
          setStatus('loading');
          void session.restore(next);
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
        break;
    }
  };

  return {
    webView,
    onMessage,
    /** iOS may reclaim the page's process under memory pressure; load it again. */
    reload: () => {
      session.detach();
      webView.current?.reload();
    },
    status,
    hasContent,
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
