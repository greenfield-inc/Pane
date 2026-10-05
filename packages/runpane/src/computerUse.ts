import { boundary, type BoundarySchema } from './boundaryDecoder';
import { invokeDaemon } from './daemonClient';
import type { ParsedArgs } from './commands';

interface ComputerUseReport {
  state: string;
  statusText: string;
  engineChoice?: string;
  engine?: string;
  permission?: string;
  appName?: string;
  detail?: string;
  checkedAt?: number;
}

/** The `computer-use:set` daemon request. */
interface ComputerUseSetRequest {
  enabled: boolean;
  engine?: 'auto' | 'cua-driver';
}

const reportSchema: BoundarySchema<ComputerUseReport> = boundary.object({
  state: boundary.string,
  statusText: boundary.string,
  engineChoice: boundary.optional(boundary.string),
  engine: boundary.optional(boundary.string),
  permission: boundary.optional(boundary.string),
  appName: boundary.optional(boundary.string),
  detail: boundary.optional(boundary.string),
  checkedAt: boundary.optional(boundary.number),
});

// Turning on waits for the engine install, which takes longer than the default call timeout.
const SET_TIMEOUT_MS = 600_000;

/**
 * `runpane computer-use status|on|off`. Not an MCP tool, and `on` refuses inside
 * Pane terminals, where agents run. A shell outside Pane can still turn it on.
 */
export async function runComputerUse(parsed: ParsedArgs, action: 'status' | 'on' | 'off'): Promise<number> {
  if (parsed.engine && action !== 'on') throw new Error('--engine applies only to runpane computer-use on.');
  if (action === 'on' && process.env.PANE_SESSION_ID) {
    throw new Error('Turn computer use on from Pane\'s Remote Access settings, or from a shell outside Pane.');
  }
  const options = { paneDir: parsed.paneDir, timeoutMs: action === 'status' ? undefined : SET_TIMEOUT_MS };
  const request: ComputerUseSetRequest = { enabled: action === 'on' };
  if (parsed.engine) request.engine = parsed.engine;
  const report = action === 'status'
    ? await invokeDaemon('computer-use:readiness', [], reportSchema, options)
    : await invokeDaemon('computer-use:set', [request], reportSchema, options);
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Computer use: ${report.statusText}`);
    if (report.state === 'needs-permission' && report.appName && report.permission) {
      console.log(`Turn on ${report.appName} in System Settings → Privacy & Security → ${report.permission}, then run \`runpane computer-use status\`.`);
    }
    if (report.state === 'failed' && report.detail) console.log(report.detail);
  }
  return action === 'status' || report.state === 'ready' || report.state === 'off' ? 0 : 1;
}
