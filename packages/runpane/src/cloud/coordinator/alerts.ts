import fs from 'node:fs';
import path from 'node:path';
import type { AlertSink, Clock, CoordinatorAlert } from './types';

const MAX_IN_MEMORY = 500;

/**
 * Alerts go to stderr (journald under systemd), an append-only JSONL file in the state dir, and an
 * optional webhook. Alert delivery never throws into the coordinator's control loop.
 */
export class JsonlAlertSink implements AlertSink {
  private readonly buffer: CoordinatorAlert[] = [];

  constructor(
    private readonly options: {
      clock: Clock;
      file: string | null;
      webhookUrl: string | null;
      log?: (line: string) => void;
    },
  ) {
    if (options.file) fs.mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
  }

  emit(input: Omit<CoordinatorAlert, 'at'>): void {
    const alert: CoordinatorAlert = { at: new Date(this.options.clock.now()).toISOString(), ...input };
    this.buffer.push(alert);
    if (this.buffer.length > MAX_IN_MEMORY) this.buffer.splice(0, this.buffer.length - MAX_IN_MEMORY);
    const line = JSON.stringify(alert);
    (this.options.log ?? ((text: string) => console.error(text)))(`[coordinator-alert] ${line}`);
    if (this.options.file) {
      try {
        fs.appendFileSync(this.options.file, `${line}\n`, { mode: 0o600 });
      } catch (error) {
        console.error(`[coordinator] could not write alert file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (this.options.webhookUrl) {
      void fetch(this.options.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: line,
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
    }
  }

  recent(limit: number): CoordinatorAlert[] {
    return this.buffer.slice(-Math.max(0, limit));
  }
}

export class MemoryAlertSink implements AlertSink {
  readonly alerts: CoordinatorAlert[] = [];

  emit(input: Omit<CoordinatorAlert, 'at'>): void {
    this.alerts.push({ at: new Date(0).toISOString(), ...input });
  }

  recent(limit: number): CoordinatorAlert[] {
    return this.alerts.slice(-limit);
  }
}
