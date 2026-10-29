import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { CONNECTION_GRACE_MS, connectionNotice, connectionPresence } from '@shared/remoteClient';

import { useDaemon } from '@/daemon';

/**
 * The active machine's presence and the bar to show under the header. The
 * grace window counts only time the person could see: it starts when the
 * connection drops, pauses in the background, and starts over on the way back.
 */
export function useConnectionPresence() {
  const { client, profile, connection } = useDaemon();
  const connected = connection.status === 'connected';
  // Each drop and each return from the background opens a new window.
  const [graceWindow, setGraceWindow] = useState(0);
  const [elapsedWindow, setElapsedWindow] = useState(-1);
  const [wasConnected, setWasConnected] = useState(connected);
  if (wasConnected !== connected) {
    setWasConnected(connected);
    setGraceWindow(current => current + 1);
  }
  const [foreground, setForeground] = useState(() => AppState.currentState !== 'background');

  useEffect(() => {
    // Control Center and Face ID pass through 'inactive' only; they keep the window.
    let backgrounded = AppState.currentState === 'background';
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') {
        backgrounded = true;
        setForeground(false);
      } else if (state === 'active' && backgrounded) {
        backgrounded = false;
        setForeground(true);
        setGraceWindow(current => current + 1);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (connected || !foreground) return;
    const timer = setTimeout(() => setElapsedWindow(graceWindow), CONNECTION_GRACE_MS);
    return () => clearTimeout(timer);
  }, [connected, foreground, graceWindow]);

  // The shared rule only compares the time down with the grace window.
  const downForMs = elapsedWindow === graceWindow ? CONNECTION_GRACE_MS : 0;
  const notice = connectionNotice(connection, downForMs, profile.label);
  return {
    presence: connectionPresence(connection.status, downForMs),
    notice: notice && connection.updateIntent ? { ...notice, message: `Updating Pane on ${profile.label} · ${connection.updateIntent.id}` } : notice,
    retry: () => client.retryNow(),
  };
}
