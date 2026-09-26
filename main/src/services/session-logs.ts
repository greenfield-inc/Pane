import { getPaneEventSink } from '../core/runtime';

interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

// Per-session history: at most 1,000 entries and 1 MiB of message/source text.
// Fixed entry metadata is bounded by the entry count as well.
const MAX_ENTRIES = 1000;
const MAX_BYTES = 1024 * 1024;
const sessionLogs = new Map<string, { entries: LogEntry[]; bytes: number }>();

function truncateUtf8(value: string, limit: number): string {
  // Slice before encoding so even a giant process chunk allocates a bounded buffer.
  const bytes = Buffer.from(value.slice(0, limit));
  if (bytes.length <= limit) return bytes.toString();
  let end = limit;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString();
}

function entryBytes(entry: LogEntry): number {
  return Buffer.byteLength(entry.message) + Buffer.byteLength(entry.source ?? '');
}

function sendSessionLogEvent(sessionId: string, entry: LogEntry): void {
  getPaneEventSink().send('session-log', {
    sessionId,
    entry,
  });
}

function sendSessionLogsClearedEvent(sessionId: string): void {
  getPaneEventSink().send('session-logs-cleared', { sessionId });
}

export function getSessionLogs(sessionId: string): LogEntry[] {
  return (sessionLogs.get(sessionId)?.entries ?? []).map(entry => ({ ...entry }));
}

// Helper function to add a log from internal sources
export function addSessionLog(sessionId: string, level: LogEntry['level'], message: string, source?: string): void {
  const boundedSource = source === undefined ? undefined : truncateUtf8(source, 1024);
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    message: truncateUtf8(message, MAX_BYTES - Buffer.byteLength(boundedSource ?? '')),
    source: boundedSource
  };

  const logs = sessionLogs.get(sessionId) ?? { entries: [], bytes: 0 };
  logs.entries.push(entry);
  logs.bytes += entryBytes(entry);
  while (logs.entries.length > MAX_ENTRIES || logs.bytes > MAX_BYTES) {
    const evicted = logs.entries.shift();
    if (evicted) logs.bytes -= entryBytes(evicted);
  }
  sessionLogs.set(sessionId, logs);

  sendSessionLogEvent(sessionId, entry);
}

// Helper to clean up logs when a session is deleted or when starting a new run
export function cleanupSessionLogs(sessionId: string): void {
  sessionLogs.delete(sessionId);

  sendSessionLogsClearedEvent(sessionId);
}
