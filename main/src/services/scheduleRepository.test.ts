import { describe, expect, it, vi } from 'vitest';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { ScheduleRepository } from './scheduleRepository';

describe('ScheduleRepository', () => {
  it('uses the indexed deadline boundary when listing runnable schedules', () => {
    const all = vi.fn(() => []);
    const prepare = vi.fn(() => ({ all }));
    // SAFETY: The repository test exercises only the prepare().all() surface supplied by this stub.
    const database = { prepare } as Database;
    const repository = new ScheduleRepository(() => database);

    repository.listRunnable(123_456);

    expect(prepare).toHaveBeenCalledWith(
      'SELECT * FROM scheduled_runs WHERE enabled = 1 AND next_run_at_ms <= ? ORDER BY next_run_at_ms ASC'
    );
    expect(all).toHaveBeenCalledWith(123_456);
  });
});
