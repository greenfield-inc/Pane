import fs from 'node:fs';
import { invokeDaemon } from './daemonClient';
import { boundary } from './boundaryDecoder';
import type { ParsedArgs } from './commands';

export async function runPeers(parsed: ParsedArgs): Promise<number> {
  const action = parsed.command.split(' ')[1];
  if (parsed.dryRun) throw new Error('Peer commands do not support --dry-run; use self, list or an unclaimed inbox to inspect.');
  if (parsed.follow && action !== 'wait') throw new Error('--follow is supported only by peers wait.');
  if (parsed.follow && parsed.timeoutMs === 0) throw new Error('--follow requires a positive timeout.');
  if (parsed.panelInput !== undefined && parsed.panelInputFile !== undefined) throw new Error('Use either --text or --input-file.');
  const text = parsed.panelInputFile !== undefined
    ? fs.readFileSync(parsed.panelInputFile === '-' ? 0 : parsed.panelInputFile, 'utf8')
    : parsed.panelInput;
  const request = {
    action, peer: parsed.peer ?? process.env.PANE_PEER_ID ?? process.env.PANE_PANEL_ID,
    to: parsed.peerTo, id: parsed.messageId, agent: parsed.agentLabel, receiver: parsed.receiver,
    status: parsed.replyStatus, text, claim: parsed.claim, includeReceived: parsed.includeReceived,
    after: parsed.afterRevision, timeoutMs: parsed.timeoutMs, limit: parsed.limit, confirmed: parsed.yes,
  };
  do {
    const result = await invokeDaemon('runpane:peers', [request], boundary.jsonObject, {
      paneDir: parsed.paneDir, timeoutMs: (parsed.timeoutMs ?? 60_000) + 10_000, eventInclude: [],
    });
    if (result.protocolVersion !== 1) throw new Error('Unsupported peer protocol response.');
    if (parsed.follow && result.timedOut === true) continue;
    // Compact JSON is the common interface for humans, agents and native bridges.
    console.log(JSON.stringify(result, null, parsed.json ? undefined : 2));
    return 0;
  } while (parsed.follow);
  return 0;
}
