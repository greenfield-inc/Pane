import { boundary } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon } from './daemonClient';

/** Exit code when something blocks the stop, so scripts can tell "blocked" from "failed" (1). */
const SAFE_TO_STOP_BLOCKED_EXIT_CODE = 3;

const safeToStopResultSchema = boundary.object({
  ok: boundary.literal(true),
  safe: boundary.boolean,
  checkedAt: boundary.string,
  version: boundary.string,
  blockers: boundary.array(boundary.object({
    condition: boundary.string,
    message: boundary.string,
    paneId: boundary.optional(boundary.string),
    panelId: boundary.optional(boundary.string),
  })),
  flush: boundary.nullable(boundary.object({
    walCheckpoint: boundary.nullable(boundary.object({
      busy: boundary.number,
      log: boundary.number,
      checkpointed: boundary.number,
    })),
    fsynced: boundary.array(boundary.string),
    syncedFilesystem: boundary.boolean,
    // Optional: daemons from before verified durability leave them out.
    durable: boundary.optional(boundary.boolean),
    failures: boundary.optional(boundary.array(boundary.string)),
    durationMs: boundary.number,
  })),
});

function safeToStopFlushMode(parsed: Pick<ParsedArgs, 'force' | 'dryRun'>): 'if-safe' | 'always' | 'never' {
  if (parsed.force && parsed.dryRun) throw new Error('runpane cloud safe-to-stop takes --force or --dry-run, not both.');
  if (parsed.force) return 'always';
  return parsed.dryRun ? 'never' : 'if-safe';
}

/** `runpane cloud safe-to-stop`: the in-sandbox form of the coordinator's idle-stop check. */
export async function runCloudSafeToStop(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon(
    'runpane:cloud:safe-to-stop',
    [{ flush: safeToStopFlushMode(parsed) }],
    safeToStopResultSchema,
    { paneDir: parsed.paneDir },
  );
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.safe ? 'Safe to stop.' : 'Not safe to stop:');
    for (const blocker of result.blockers) console.log(`  ${blocker.condition}: ${blocker.message}`);
    if (result.flush) {
      console.log(`Flushed in ${result.flush.durationMs} ms (${result.flush.fsynced.length} paths fsynced, filesystem synced: ${result.flush.syncedFilesystem}, durable: ${result.flush.durable === true}).`);
    }
  }
  return result.safe ? 0 : SAFE_TO_STOP_BLOCKED_EXIT_CODE;
}
