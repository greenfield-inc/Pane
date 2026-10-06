import { getPaneEventSink } from '../core/runtime';
import { SessionLogBuffer, type LogEntry } from '../../../shared/utils/session-log-buffer';

// Only active sessions are registered. Retiring removes the entry, so late output
// cannot recreate history and no ever-growing set of deleted IDs is needed.
const sessionLogs = new Map<string, SessionLogBuffer>();

export function startSessionLogs(sessionId: string): void {
  if (!sessionLogs.has(sessionId)) sessionLogs.set(sessionId, new SessionLogBuffer());
}

export function getSessionLogs(sessionId: string): LogEntry[] {
  return sessionLogs.get(sessionId)?.snapshot() ?? [];
}

export function addSessionLog(sessionId: string, level: LogEntry['level'], message: string, source?: string): void {
  const buffer = sessionLogs.get(sessionId) ?? new SessionLogBuffer();
  const entry = buffer.append({ timestamp: new Date().toISOString(), level, message, source });
  getPaneEventSink().send('session-log', { sessionId, entry });
}

export function clearSessionLogs(sessionId: string): void {
  sessionLogs.get(sessionId)?.clear();
  getPaneEventSink().send('session-logs-cleared', { sessionId });
}

export function cleanupSessionLogs(sessionId: string): void {
  sessionLogs.delete(sessionId);
  getPaneEventSink().send('session-logs-cleared', { sessionId });
}
