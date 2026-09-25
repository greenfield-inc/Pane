import type { ParsedArgs } from './commands';
import { confirmMutation } from './daemonActions';
import { invokeDaemon } from './daemonClient';
import { buildPaneLink } from './links';
import {
  buildPaneCreateRequest,
  buildPanelInputRequest,
  paneCreateResultSchema,
  panelListResultSchema,
  panelScreenResultSchema,
  panelSubmitResultSchema,
  workspaceStateResultSchema,
} from './localControl';

type AgentStatus = 'working' | 'ready' | 'blocked' | 'idle' | 'exited' | 'unknown';

const STATUS_BY_KIND = new Map<string, AgentStatus>([
  ['agent.busy', 'working'],
  ['agent.ready', 'ready'],
  ['agent.blocked', 'blocked'],
  ['agent.idle', 'idle'],
  ['panel.exited', 'exited'],
  ['agent.unknown', 'unknown'],
]);

/** `agents start`: panes create in the background, wait for the agent, send the task, return ids and a link. */
export async function runAgentsStart(parsed: ParsedArgs): Promise<number> {
  if (!parsed.initialInput) throw new Error('runpane agents start requires --prompt <task>.');
  await confirmMutation(parsed);
  const request = await buildPaneCreateRequest({ ...parsed, source: 'agent', noFocus: true, focus: false, waitReady: true, yes: true });
  const created = await invokeDaemon('runpane:panes:create', [request], paneCreateResultSchema, {
    paneDir: parsed.paneDir,
    timeoutMs: (parsed.timeoutMs ?? 120_000) + (parsed.readyTimeoutMs ?? 30_000) + 10_000,
  });
  const item = created.items[0];
  if (!item || !item.ok || !item.sessionId || !item.panelId) {
    const reason = item && 'error' in item ? item.error.message : 'Pane did not report a created panel.';
    throw new Error(`Could not start the agent: ${reason}`);
  }
  const paneId = item.sessionId;
  const ready = item.readiness?.ok ?? false;
  const promptDelivered = item.initialInput?.delivered ?? false;
  const result = {
    ok: ready && promptDelivered,
    paneId: paneId,
    panelId: item.panelId,
    name: item.name,
    worktreePath: item.worktreePath,
    link: buildPaneLink({ kind: 'pane', id: paneId, panelId: item.panelId }),
    ready,
    promptDelivered,
    next: ready && promptDelivered
      ? `Check on it with \`runpane agents status --pane ${paneId}\`.`
      : `The agent started but the task may not have reached it. Run \`runpane agents status --pane ${paneId}\`, then \`runpane agents send --pane ${paneId} --text <task> --yes\` if needed.`,
  };
  print(parsed, result, `Started ${result.name ?? result.paneId}: ${result.link}\n${result.next}`);
  return result.ok ? 0 : 1;
}

/** `agents status`: the agent's current state from the workspace journal plus its screen. */
export async function runAgentsStatus(parsed: ParsedArgs): Promise<number> {
  const { paneId, panelId } = await resolveAgentPanel(parsed);
  const [state, screen] = await Promise.all([
    invokeDaemon('runpane:workspace:state', [{}], workspaceStateResultSchema, { paneDir: parsed.paneDir }),
    invokeDaemon('runpane:panels:screen', [{ panelId, limit: parsed.limit ?? 40 }], panelScreenResultSchema, { paneDir: parsed.paneDir }),
  ]);
  const entry = state.entries.find((candidate) => candidate.panelId === panelId);
  const result = {
    ok: true as const,
    paneId,
    panelId,
    paneName: entry?.paneName,
    status: (entry && STATUS_BY_KIND.get(entry.kind)) ?? 'unknown',
    screen: screen.text,
    hasUndeliveredText: screen.composer.hasUndeliveredText,
    link: buildPaneLink({ kind: 'pane', id: paneId, panelId }),
  };
  print(parsed, result, `${result.status}\n${result.screen}`);
  return 0;
}

/** `agents send`: submit a follow-up and report whether Pane saw it leave the composer. */
export async function runAgentsSend(parsed: ParsedArgs): Promise<number> {
  const { paneId, panelId } = await resolveAgentPanel(parsed);
  await confirmMutation(parsed);
  const request = buildPanelInputRequest({ ...parsed, panelId }, 'submit');
  const sent = await invokeDaemon('runpane:panels:submit', [request], panelSubmitResultSchema, { paneDir: parsed.paneDir });
  const delivered = sent.ok && sent.verifiedSubmitted;
  const result = {
    ok: delivered,
    paneId,
    panelId,
    delivered,
    blocked: sent.blocked?.message,
    next: delivered
      ? `Check on it with \`runpane agents status --pane ${paneId}\`.`
      : `The message may still be in the composer. Run \`runpane agents status --panel ${panelId}\` to see the screen.`,
  };
  print(parsed, result, delivered ? `Delivered to ${panelId}.` : `Not confirmed: ${result.blocked ?? result.next}`);
  return delivered ? 0 : 1;
}

/** A panel id as given, or the agent panel of a Pane (its CLI agent tab, else its first tab). */
async function resolveAgentPanel(parsed: ParsedArgs): Promise<{ paneId: string; panelId: string }> {
  if ((parsed.paneId ? 1 : 0) + (parsed.panelId ? 1 : 0) !== 1) {
    throw new Error(`runpane ${parsed.command} needs exactly one of --pane or --panel.`);
  }
  if (parsed.panelId) {
    const screen = await invokeDaemon('runpane:panels:screen', [{ panelId: parsed.panelId, limit: 1 }], panelScreenResultSchema, { paneDir: parsed.paneDir });
    return { paneId: screen.paneId ?? '', panelId: parsed.panelId };
  }
  const paneId = parsed.paneId ?? '';
  const { panels } = await invokeDaemon('runpane:panels:list', [{ paneId }], panelListResultSchema, { paneDir: parsed.paneDir });
  const panel = panels.find((candidate) => candidate.isCliPanel || candidate.agentType) ?? panels[0];
  if (!panel) throw new Error(`Pane ${paneId} has no panels. Start an agent with \`runpane agents start\`.`);
  return { paneId, panelId: panel.panelId };
}

function print<Result>(parsed: ParsedArgs, result: Result, text: string): void {
  console.log(parsed.json ? JSON.stringify(result, null, 2) : text);
}
