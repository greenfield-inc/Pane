import fs from 'node:fs';
import path from 'node:path';
import { boundary, decodeBoundary } from '../../../boundaryDecoder';
import type { JsonObject } from '../../../boundaryDecoder';
import type { Clock } from '../types';

/**
 * One line per broker call in `<stateDir>/github-audit.jsonl` (0600): who, from which node, what,
 * on which repo and ref or number, and the outcome. Never tokens and never text: titles and bodies
 * are recorded by length only.
 */
export interface GitHubAuditEntry {
  callerId: string;
  label: string | null;
  node: string | null;
  endpoint: string;
  repo: string | null;
  target: string | null;
  outcome: string;
  httpStatus: number;
  githubId?: number | null;
  githubUrl?: string | null;
  githubStatus?: number | null;
  bundleSha?: string | null;
  bundleBytes?: number | null;
  titleLength?: number | null;
  bodyLength?: number | null;
  durationMs: number;
}

export interface GitHubAudit {
  append(entry: GitHubAuditEntry): void;
  recent(limit: number): JsonObject[];
}

const MAX_READ_BYTES = 4 * 1024 * 1024;

/** An append-only JSONL audit file (0600) with a bounded tail read; the entry type says what may go in it. */
export class JsonlAuditLog<Entry extends object> {
  constructor(private readonly file: string, private readonly clock: Clock) {}

  append(entry: Entry): void {
    const line = `${JSON.stringify({ at: new Date(this.clock.now()).toISOString(), ...entry })}\n`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch (error) {
      console.error(`[coordinator] audit write to ${path.basename(this.file)} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  recent(limit: number): JsonObject[] {
    let text: string;
    try {
      const size = fs.statSync(this.file).size;
      const handle = fs.openSync(this.file, 'r');
      try {
        const length = Math.min(size, MAX_READ_BYTES);
        const buffer = Buffer.alloc(length);
        fs.readSync(handle, buffer, 0, length, size - length);
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      return [];
    }
    const entries: JsonObject[] = [];
    for (const line of text.split('\n').filter(Boolean).slice(-Math.max(1, limit))) {
      try {
        entries.push(decodeBoundary(JSON.parse(line), boundary.jsonObject));
      } catch {
        // a partial first line from the tail read
      }
    }
    return entries;
  }
}

export class JsonlGitHubAudit extends JsonlAuditLog<GitHubAuditEntry> implements GitHubAudit {}

/** Sliding one-hour windows, per key (`push:<session>`, `write:*`, ...). In memory: a restart forgives. */
export class HourlyLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {}

  /** Records one call and returns true, or returns false when `key` already has `limit` calls this hour. */
  take(keys: ReadonlyArray<{ key: string; limit: number }>): string | null {
    const now = this.clock.now();
    for (const { key, limit } of keys) {
      const recent = (this.windows.get(key) ?? []).filter((at) => now - at < 3_600_000);
      this.windows.set(key, recent);
      if (recent.length >= limit) return key;
    }
    for (const { key } of keys) this.windows.get(key)?.push(now);
    return null;
  }
}
