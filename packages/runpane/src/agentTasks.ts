import type { ParsedArgs } from './commands';
import { confirmMutation } from './daemonActions';
import { invokeDaemon } from './daemonClient';
import { buildPaneLink } from './links';
import { describeReport } from './watchLines';
import {
  type AgentReport,
  buildPaneCreateRequest,
  buildPanelCreateRequest,
  buildPanelInputRequest,
  markSuggestionLine,
  paneCreateResultSchema,
  panelCreateResultSchema,
  panelListResultSchema,
  panelScreenResultSchema,
  panelSubmitResultSchema,
  printPromptNotes,
  workspaceStateResultSchema,
} from './localControl';

type AgentStatus = 'working' | 'ready' | 'blocked' | 'idle' | 'exited' | 'unknown';

interface AgentStatusResult {
  ok: true;
  paneId: string;
  panelId: string;
  paneName?: string;
  status: AgentStatus;
  screen: string;
  hasUndeliveredText: boolean;
  link: string;
  report?: AgentReport;
}

/** Terminal control bytes other than tab and newline are keystrokes, not message text. */
function hasControlCharacters(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (code < 32 && code !== 9 && code !== 10) || code === 127;
  });
}

const STATUS_BY_KIND = new Map<string, AgentStatus>([
  ['agent.busy', 'working'],
  ['agent.ready', 'ready'],
  ['agent.blocked', 'blocked'],
  ['agent.idle', 'idle'],
  ['panel.exited', 'exited'],
  ['agent.unknown', 'unknown'],
]);

/**
 * `agents start`: start an agent on a task and return ids and a link.
 * With `--pane <id>` the agent opens as a new tab in that existing Pane (same worktree and branch);
 * without it, Pane creates a new Pane for new work. 1 feature = 1 worktree = 1 branch = 1 Pane.
 */
export async function runAgentsStart(parsed: ParsedArgs): Promise<number> {
  if (!parsed.initialInput) throw new Error('runpane agents start requires --prompt <task>.');
  const paneId = parsed.paneId;
  if (paneId && (parsed.repo || parsed.name || parsed.baseBranch)) {
    throw new Error('runpane agents start takes either --pane <id> (a new tab in existing work) or --repo and --name (a new Pane for new work), not both. Drop --repo, --name and --base-branch, or drop --pane.');
  }
  if (!paneId && (!parsed.repo || !parsed.name)) {
    throw new Error('runpane agents start needs --pane <id> to add a tab to existing work, or --repo and --name to start new work in a new Pane.');
  }
  await confirmMutation(parsed);
  if (paneId) return startAgentInPane(parsed, paneId);
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
  const newPaneId = item.sessionId;
  const ready = item.readiness?.ok ?? false;
  const promptDelivered = item.initialInput?.delivered ?? false;
  const result = {
    ok: ready && promptDelivered,
    paneId: newPaneId,
    panelId: item.panelId,
    name: item.name,
    worktreePath: item.worktreePath,
    link: buildPaneLink({ kind: 'pane', id: newPaneId, panelId: item.panelId }),
    ready,
    promptDelivered,
    next: ready && promptDelivered
      ? `Check on it with \`runpane agents status --pane ${newPaneId}\`.`
      : `The agent started but the task may not have reached it. Run \`runpane agents status --pane ${newPaneId}\`, then \`runpane agents send --pane ${newPaneId} --text <task> --yes\` if needed.`,
  };
  print(parsed, result, `Started ${result.name ?? result.paneId}: ${result.link}\n${result.next}`);
  return result.ok ? 0 : 1;
}

/** `agents start --pane`: a new agent tab in an existing Pane; it shares the Pane's worktree and branch. */
async function startAgentInPane(parsed: ParsedArgs, paneId: string): Promise<number> {
  const request = await buildPanelCreateRequest({ ...parsed, source: 'agent', noFocus: true, focus: false, waitReady: true, yes: true });
  let created: ReturnType<typeof panelCreateResultSchema.decode>;
  try {
    created = await invokeDaemon('runpane:panels:create', [request], panelCreateResultSchema, {
      paneDir: parsed.paneDir,
      timeoutMs: (parsed.readyTimeoutMs ?? 30_000) + 10_000,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open the agent as a tab in Pane ${paneId}: ${reason} Nothing else was changed. Check the Pane id with \`runpane panes list --json\`; if the work's branch has no Pane yet, start it with --repo and --name instead.`);
  }
  const ready = created.readiness?.ok ?? false;
  const promptDelivered = created.initialInput?.delivered ?? false;
  const result = {
    ok: ready && promptDelivered,
    paneId,
    panelId: created.panelId,
    name: created.title,
    link: buildPaneLink({ kind: 'pane', id: paneId, panelId: created.panelId }),
    ready,
    promptDelivered,
    next: ready && promptDelivered
      ? `Check on it with \`runpane agents status --panel ${created.panelId}\`.`
      : `The agent started but the task may not have reached it. Run \`runpane agents status --panel ${created.panelId}\`, then \`runpane agents send --panel ${created.panelId} --text <task> --yes\` if needed.`,
  };
  print(parsed, result, `Started ${result.name} in Pane ${paneId}: ${result.link}\n${result.next}`);
  return result.ok ? 0 : 1;
}

/** `agents status`: the agent's current state from the workspace journal plus its screen. */
export async function runAgentsStatus(parsed: ParsedArgs): Promise<number> {
  const { paneId, panelId } = await resolveAgentPanel(parsed);
  const [state, screen, report] = await Promise.all([
    invokeDaemon('runpane:workspace:state', [{}], workspaceStateResultSchema, { paneDir: parsed.paneDir }),
    invokeDaemon('runpane:panels:screen', [{ panelId, limit: parsed.limit ?? 40 }], panelScreenResultSchema, { paneDir: parsed.paneDir }),
    readPanelReport(parsed, paneId, panelId),
  ]);
  const entry = state.entries.find((candidate) => candidate.panelId === panelId);
  const result: AgentStatusResult = {
    ok: true,
    paneId,
    panelId,
    paneName: entry?.paneName,
    status: (entry && STATUS_BY_KIND.get(entry.kind)) ?? 'unknown',
    screen: screen.text,
    hasUndeliveredText: screen.composer.hasUndeliveredText,
    link: buildPaneLink({ kind: 'pane', id: paneId, panelId }),
  };
  if (report) result.report = report;
  const reportLine = report ? `\nReport: ${describeReport(report)} (${report.reportedAt})` : '';
  print(parsed, result, `${result.status}${reportLine}\n${markSuggestionLine(result.screen, screen.composer.ghostText)}`);
  return 0;
}

/** The panel's latest `runpane report`, from its Pane's panel list. */
async function readPanelReport(parsed: ParsedArgs, paneId: string, panelId: string): Promise<AgentReport | undefined> {
  if (!paneId) return undefined;
  const { panels } = await invokeDaemon('runpane:panels:list', [{ paneId }], panelListResultSchema, { paneDir: parsed.paneDir });
  return panels.find((candidate) => candidate.panelId === panelId)?.report;
}

/** `agents send`: submit a follow-up and report whether the agent took or queued it. */
export async function runAgentsSend(parsed: ParsedArgs): Promise<number> {
  if (parsed.panelInput !== undefined && hasControlCharacters(parsed.panelInput)) {
    throw new Error('runpane agents send types a message and presses Enter, so it cannot send keys such as arrows, Escape, or Ctrl-C. '
      + `To answer a menu, press keys with \`runpane panels input --panel <panel-id> --keys down,enter --yes\`, then check the screen with \`runpane agents status\`.`);
  }
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
    delivery: sent.delivery,
    blocked: sent.blocked?.message,
    promptFile: sent.promptFile,
    warnings: sent.warnings,
    next: delivered
      ? `Check on it with \`runpane agents status --pane ${paneId}\`.`
      : sent.nextCommand
        ? `The message is still in the composer. Run \`${sent.nextCommand}\`, then \`runpane agents status --panel ${panelId}\` to verify delivery.`
        : `The message may still be in the composer. Run \`runpane agents status --panel ${panelId}\` to see the screen.`,
  };
  const how = sent.delivery ? ` (${sent.delivery.state}, from the ${sent.delivery.evidence})` : '';
  print(parsed, result, delivered ? `Delivered to ${panelId}${how}.` : `Not confirmed${how}: ${result.blocked ?? result.next}`);
  if (!parsed.json) printPromptNotes(result);
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
  if (!panel) throw new Error(`Pane ${paneId} has no panels. Start an agent in it with \`runpane agents start --pane ${paneId} --agent <agent> --prompt <task> --yes\`.`);
  return { paneId, panelId: panel.panelId };
}

function print<Result>(parsed: ParsedArgs, result: Result, text: string): void {
  console.log(parsed.json ? JSON.stringify(result, null, 2) : text);
}
