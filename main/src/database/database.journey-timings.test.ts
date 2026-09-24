import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function openDatabase(): DatabaseService {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-journey-timings-'));
  tempDirs.push(tempDir);
  const database = new DatabaseService(path.join(tempDir, 'sessions.db'));
  database.initialize();
  return database;
}

describe('journey timings', () => {
  it('reports nearest-rank p50 and p75 per journey, in journey order', () => {
    const database = openDatabase();
    for (const durationMs of [800, 100, 400, 700, 200, 600, 300, 500]) {
      database.recordJourneyTiming('switch_pane', durationMs);
    }
    database.recordJourneyTiming('app_launch', 1234.4);

    expect(database.getJourneyTimingSummary()).toEqual([
      { journey: 'app_launch', count: 1, p50Ms: 1234, p75Ms: 1234 },
      { journey: 'switch_pane', count: 8, p50Ms: 400, p75Ms: 600 },
    ]);
    database.close();
  });

  it('keeps only the most recent 200 samples of each journey', () => {
    const database = openDatabase();
    for (let run = 0; run < 250; run++) {
      database.recordJourneyTiming('send_prompt', run < 50 ? 10_000 : 20);
    }
    database.recordJourneyTiming('create_pane', 900);

    expect(database.getJourneyTimingSummary()).toEqual([
      { journey: 'create_pane', count: 1, p50Ms: 900, p75Ms: 900 },
      { journey: 'send_prompt', count: 200, p50Ms: 20, p75Ms: 20 },
    ]);
    database.close();
  });
});
