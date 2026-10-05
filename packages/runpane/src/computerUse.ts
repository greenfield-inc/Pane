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

/**
 * `runpane computer-use status|on|off`. Deliberately not an MCP tool: only a
 * person (here or in Settings) turns computer use on for a machine.
 */
export async function runComputerUse(parsed: ParsedArgs, action: 'status' | 'on' | 'off'): Promise<number> {
  const options = { paneDir: parsed.paneDir };
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
