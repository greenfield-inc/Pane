export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  source?: string;
}

const MAX_ENTRIES = 1000;
const MAX_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

function truncateUtf8(value: string, limit: number): string {
  const bytes = encoder.encode(value.slice(0, limit));
  if (bytes.length <= limit) return decoder.decode(bytes);
  let end = limit;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

function entryBytes(entry: LogEntry): number {
  return encoder.encode(entry.message).length + encoder.encode(entry.source ?? '').length;
}

/** Shared limits for retained main-process history and the renderer's live view. */
export class SessionLogBuffer {
  private entries: LogEntry[] = [];
  private bytes = 0;

  append(value: LogEntry): LogEntry {
    const source = value.source === undefined ? undefined : truncateUtf8(value.source, 1024);
    const entry = { ...value, source, message: truncateUtf8(value.message, MAX_BYTES - encoder.encode(source ?? '').length) };
    this.entries.push(entry);
    this.bytes += entryBytes(entry);
    while (this.entries.length > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const evicted = this.entries.shift();
      if (evicted) this.bytes -= entryBytes(evicted);
    }
    return entry;
  }

  snapshot(): LogEntry[] {
    return this.entries.map(entry => ({ ...entry }));
  }

  clear(): void {
    this.entries = [];
    this.bytes = 0;
  }
}
