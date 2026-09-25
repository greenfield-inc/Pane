import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { WebView, WebViewMessageEvent } from 'react-native-webview';

import { useDaemon, useDaemonEvent } from '@/daemon';
import { useTheme } from '@/theme';

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
  const [atBottom, setAtBottom] = useState(true);
  const [screenText, setScreenText] = useState('');
  const [size, setSize] = useState<TerminalSize | null>(null);

  // Output arrives in bursts of small events; hand it to xterm once per frame.
  const pending = useRef('');
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
        setStatus('ready');
        setError(null);
      },
      write: data => {
        pending.current += data;
        frame.current ??= requestAnimationFrame(flush);
      },
    },
    onError: cause => {
      setError(cause);
      setStatus('error');
    },
  }));

  useDaemonEvent('terminal:output', event => session.receiveOutput(event.args[0]));

  const restore = useEffectEvent(() => {
    if (size) void session.restore(size);
  });

  // Restore once the page has measured itself, and again after every
  // reconnect: the event stream does not replay output missed while offline.
  const connected = connection.status === 'connected';
  const measured = size !== null;
  useEffect(() => {
    if (connected && measured) restore();
  }, [connected, measured]);

  useEffect(() => {
    const keepAlive = setInterval(() => session.keepAlive(), VISIBILITY_REFRESH_MS);
    // Only a real trip to the background detaches. Notification Center, Face ID
    // and permission prompts pass through 'inactive' and leave the screen live.
    let backgrounded = false;
    const appState = AppState.addEventListener('change', state => {
      if (state === 'background') {
        backgrounded = true;
        session.detach();
      } else if (state === 'active' && backgrounded) {
        backgrounded = false;
        restore();
      }
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
        if (size && connected) {
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
    error,
    atBottom,
    screenText,
    rows: size?.rows ?? 0,
    retry: () => {
      setStatus('loading');
      if (size) void session.restore(size);
    },
    sendInput: (data: string) => session.sendInput(data),
    scrollLines: (lines: number) => send({ type: 'scroll', lines }),
    scrollToBottom: () => send({ type: 'scrollToBottom' }),
  };
}
