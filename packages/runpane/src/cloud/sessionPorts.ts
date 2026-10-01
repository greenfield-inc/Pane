import { checkUrlFromHere, CLOUD_PORT_USAGE, parsePortsArgv, runPortsCommand } from '../sessionPorts';
import type { CloudDeps } from './commands';
import { findHost } from './store';

/** Opening may wait for the Session's first TLS certificate (up to ~45 s) before falling back to HTTP. */
const PORT_INVOKE_TIMEOUT_MS = 90_000;

/** `runpane cloud port open|list|close <host> ...`: the Session daemon's `runpane:ports:*` over the tailnet. */
export async function runCloudPortCommand(argv: readonly string[], deps: CloudDeps): Promise<number> {
  const { host, command } = parsePortsArgv(argv, { withHost: true, usage: CLOUD_PORT_USAGE });
  const record = findHost(await deps.store.listHosts(), host ?? '');
  const name = record.profile.cloud.hostname;
  if (!record.profile.baseUrl || !record.profile.token) throw new Error(`${name} has no daemon address yet; its setup never finished.`);
  return runPortsCommand(command, {
    async invoke(channel, args) {
      try {
        return await deps.invokeDaemon(record.profile, channel, args, PORT_INVOKE_TIMEOUT_MS);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/No Pane daemon command registered/u.test(message)) {
          throw new Error(`${name}'s Pane daemon predates Session ports; update the Pane in that Session first.`);
        }
        throw new Error(`${name}: ${message}${/connect|ECONN|ETIMEDOUT|ENOTFOUND|timed out/iu.test(message) ? ` (is it asleep? run runpane cloud wake ${name})` : ''}`);
      }
    },
    stdout: deps.stdout,
    checkUrl: command.sub === 'list' ? checkUrlFromHere : undefined,
  });
}
