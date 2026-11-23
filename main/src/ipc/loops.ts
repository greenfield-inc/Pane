import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { LoopManager } from '../services/loops/loopManager';
import type { StoredLoop } from '../services/loops/loopRepository';
import type { LoopRunStart, LoopSessionRecovery } from '../services/loops/loopManager';
import { previewLoopSchedule } from '../services/loops/loopSchedule';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { LOOP_AGENTS, LOOP_NEW_SESSION, isLoopAgent, loopInputSchema, loopSlug, type LoopAgent } from '../../../shared/types/loop';
import { ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX } from '../../../shared/types/orchestrationSession';
import type { RunpanePaneCreateRequest } from '../../../shared/types/runpaneOrchestration';
import { PaneError } from '../../../shared/paneError';
import { FOLDER_TRUST_PROMPT } from '../services/agents/folderTrustPrompt';
import { isPlainAgentCommand, normalizeProcessName, tokenizeShellCommand } from '../services/agents/agentIdentity';
import { agentLabel, agentTerminalCommand, configuredAgentSchema } from '../../../shared/agents';

const LOOP_CHANNELS = [
  'loops:list',
  'loops:save',
  'loops:delete',
  'loops:set-enabled',
  'loops:run-now',
  'loops:preview',
] as const;

/** The parts of the `runpane` results a run reads. */
const failureSchema = boundary.optional(boundary.object({ message: boundary.string }));
// `blocked` is Pane's own prompt detection (`detectPanelBlocker`), as `panels wait` reports it.
const readinessSchema = boundary.optional(boundary.object({ ok: boundary.boolean, reason: failureSchema, blocked: failureSchema }));
type Readiness = ReturnType<typeof readinessSchema.decode>;
const paneCreateResultSchema = boundary.object({
  items: boundary.array(boundary.object({
    ok: boundary.boolean,
    sessionId: boundary.optional(boundary.string),
    error: failureSchema,
    readiness: readinessSchema,
    initialInput: boundary.optional(boundary.object({
      error: failureSchema,
      delivery: boundary.optional(boundary.object({ message: boundary.optional(boundary.string) })),
    })),
  })),
});

const paneArchiveResultSchema = boundary.object({ blocked: failureSchema });
const loopSessionSchema = boundary.object({
  session: boundary.object({
    id: boundary.string,
    name: boundary.string,
    // Any Session agent, so one loops cannot run gets its own refusal instead of a decode error.
    agent: configuredAgentSchema,
    launchCommand: boundary.optional(boundary.string),
    archived: boundary.optional(boundary.boolean),
    isPinned: boundary.optional(boundary.boolean),
    panelIds: boundary.object({ claude: boundary.string, codex: boundary.string, cursor: boundary.string }),
  }),
});
// The Session path also reads why a wait failed and what the panel is running.
const panelResumeResultSchema = boundary.object({
  readiness: boundary.optional(boundary.object({
    ok: boundary.boolean,
    blocked: failureSchema,
    reason: boundary.optional(boundary.object({ code: boundary.string, message: boundary.string })),
    state: boundary.object({ running: boundary.boolean, agentType: boundary.optional(boundary.string), activityStatus: boundary.optional(boundary.string) }),
  })),
});
const panelSubmitResultSchema = boundary.object({ ok: boundary.boolean });

type LoopResponse<T> = { success: true; data?: T } | { success: false; error: string };

async function respond<T>(work: () => T | Promise<T>): Promise<LoopResponse<T>> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Loops (scheduled tasks) for the app. Daemon-owned like `sessions:*`, so the
 * UI and paired remote clients use them with the same access. `runpane loops`
 * uses the `runpane:loops:*` handlers in `runpane.ts`.
 */
export function registerLoopHandlers(ipcMain: IpcMain, loopManager: LoopManager, commandRegistry: PaneCommandRegistry): void {
  commandRegistry.register('loops:list', () => respond(() => loopManager.list()));
  commandRegistry.register('loops:save', (value: PaneCommandValue) =>
    respond(() => loopManager.save(decodeBoundary(value, loopInputSchema))));
  commandRegistry.register('loops:delete', (id: PaneCommandValue) =>
    respond(() => loopManager.delete(decodeBoundary(id, boundary.string))));
  commandRegistry.register('loops:set-enabled', (id: PaneCommandValue, enabled: PaneCommandValue) =>
    respond(() => loopManager.setEnabled(decodeBoundary(id, boundary.string), decodeBoundary(enabled, boundary.boolean))));
  commandRegistry.register('loops:run-now', (id: PaneCommandValue) =>
    respond(() => loopManager.runNow(decodeBoundary(id, boundary.string))));
  commandRegistry.register('loops:preview', (cron: PaneCommandValue) =>
    respond(() => previewLoopSchedule(decodeBoundary(cron, boundary.string), Date.now())));
  commandRegistry.bindChannels(ipcMain, LOOP_CHANNELS);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Start a loop run. A project loop runs through `runpane panes create`: a new
 * unpinned Pane in a fresh worktree from the project's default base branch.
 * A Session loop sends its prompt to the Session's agent tab.
 *
 * The built-in agent templates launch without permission prompts (`claude
 * --dangerously-skip-permissions`, `codex --yolo`, `cursor-agent --force`),
 * which is what an unattended run needs; the form and the Loops page say so.
 */
export async function startLoopRun(
  commandRegistry: PaneCommandRegistry,
  loop: StoredLoop,
  slotAtMs: number,
  sessionContext: SessionRunContext,
): Promise<LoopRunStart> {
  if (loop.orchestrationSessionId) return sendSessionLoopRun(commandRegistry, sessionContext, loop);
  const { projectId } = loop;
  if (projectId === undefined) throw new Error('This loop has no project or Session to run in.');
  const slot = new Date(slotAtMs);
  const stamp = `${slot.getFullYear()}${pad(slot.getMonth() + 1)}${pad(slot.getDate())}-${pad(slot.getHours())}${pad(slot.getMinutes())}`;
  const label = `${slot.toLocaleString('en-US', { month: 'short' })} ${slot.getDate()} ${pad(slot.getHours())}:${pad(slot.getMinutes())}`;
  const name = `${loopSlug(loop.name)} · ${label}`;
  const request: RunpanePaneCreateRequest = {
    repo: { id: projectId },
    noFocus: true,
    // Wait for the agent so the prompt's delivery is checked, and a run that never got it says so.
    waitReady: Boolean(loop.initialInput),
    panes: [{
      name,
      worktreeName: `${loopSlug(loop.worktreeTemplate ?? `loop-${loop.name}`)}-${stamp}`,
      pinned: false,
      tool: loop.toolCommand
        ? { command: loop.toolCommand, initialInput: loop.initialInput }
        : { agent: loop.agent ?? 'claude', initialInput: loop.initialInput },
    }],
  };
  const result = decodeBoundary(await commandRegistry.invoke('runpane:panes:create', [request]), paneCreateResultSchema);
  const item = result.items[0];
  if (!item?.sessionId) throw new Error(item?.error?.message ?? 'Pane creation returned no Pane.');
  // `panes create` names a Pane after its worktree when given one; label the run by loop and slot.
  // A failed rename leaves the worktree's name; the run itself started.
  await commandRegistry.invoke('runpane:panes:rename', [{ paneId: item.sessionId, name }]).catch(() => undefined);
  if (item.ok) return { sessionId: item.sessionId };
  // The Pane exists but was not doing its job at start: the agent was stuck at a prompt, never became ready, or the prompt did not arrive.
  const warning = readinessWarning(item.readiness)
    ?? `Pane could not confirm the prompt was submitted. ${item.error?.message ?? item.initialInput?.error?.message ?? item.initialInput?.delivery?.message ?? ''}`.trim();
  return { sessionId: item.sessionId, warning };
}

/**
 * Why an agent was not ready for its prompt at start, or null when it was.
 * Warnings are written once, so each says what was true when the run started.
 */
function readinessWarning(readiness: Readiness): string | null {
  const blocked = readiness?.blocked?.message;
  if (blocked !== undefined) {
    // Pane never answers trust prompts for an unattended run; the person decides.
    return FOLDER_TRUST_PROMPT.test(blocked)
      ? 'When it started, the run was stopped at the agent\'s folder-trust prompt in its new worktree. '
        + 'If it is still there, open the run and answer it, or trust the project folder in the agent once so later runs start on their own.'
      : 'When it started, the run was stopped at a prompt in its terminal. If it is still there, open the run and answer it.';
  }
  if (readiness?.ok === false) {
    return `When the run started, the agent did not become ready, so Pane could not confirm it got its prompt. ${readiness.reason?.message ?? ''}`.trim();
  }
  return null;
}

type LoopSession = ReturnType<typeof loopSessionSchema.decode>['session'];

async function getLoopSession(commandRegistry: PaneCommandRegistry, target: string): Promise<LoopSession> {
  const selector = target.startsWith(ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX) ? { sessionId: target } : { name: target };
  return decodeBoundary(await commandRegistry.invoke('runpane:sessions:get', [selector]), loopSessionSchema).session;
}

/**
 * A new Session for a loop, named after it. An archived Session keeps its name, so a taken
 * name gets a number: `standup 2`. Its empty launch command means the agent's template.
 */
async function createLoopSession(commandRegistry: PaneCommandRegistry, name: string, agent: LoopAgent): Promise<LoopSession> {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name} ${attempt}`;
    try {
      return decodeBoundary(await commandRegistry.invoke('runpane:sessions:create', [{ name: candidate, agent, launchCommand: '' }]), loopSessionSchema).session;
    } catch (error) {
      if (attempt >= 9 || !/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

/**
 * A Session loop's Session, ready for a run. An archived one is restored, unpinned, and a
 * missing one is recreated from the loop's name and agent; either way the run says so, and the
 * loop's card offers Undo.
 */
async function readyLoopSession(commandRegistry: PaneCommandRegistry, loop: StoredLoop): Promise<{ session: LoopSession; recovered?: LoopSessionRecovery }> {
  const target = loop.orchestrationSessionId ?? '';
  let session: LoopSession;
  try {
    session = await getLoopSession(commandRegistry, target);
  } catch (error) {
    if (!(error instanceof PaneError && error.code === 'ERR_SESSION_NOT_FOUND')) throw error;
    // Saving a Session loop requires its agent, so a stored one always has it.
    if (!loop.agent) throw error;
    const created = await createLoopSession(commandRegistry, loop.name, loop.agent);
    return { session: created, recovered: { kind: 'recreated', ...recoveredSession(created) } };
  }
  if (!session.archived) return { session };
  await commandRegistry.invoke('runpane:sessions:update', [{ selector: { sessionId: session.id }, input: { archived: false, isPinned: false, source: 'user' } }]);
  return { session: { ...session, archived: false }, recovered: { kind: 'restored', ...recoveredSession(session) } };
}

function recoveredSession(session: LoopSession): Omit<LoopSessionRecovery, 'kind'> {
  return { sessionId: session.id, sessionName: session.name };
}

/** What a Session loop run reads from Pane: the command each terminal last launched, if Pane launched one. */
export interface SessionRunContext {
  launchedCommand: (panelId: string) => string | undefined;
}

/** The words a launch error printed, as `panels wait` quotes them. */
const PRINTED = /It printed: "(.+?)"\./;

/**
 * A Session loop run: start the Session's agent tab if it is stopped, as
 * `runpane panels resume --wait-ready`, then send the prompt as `panels submit`.
 * No Pane, worktree or branch is created. The prompt goes only to a live agent
 * of the Session's kind that was launched without permission prompts: ready,
 * or working on a turn (it queues the prompt). Anything else is reported in
 * the app's words, never typed into.
 */
async function sendSessionLoopRun(commandRegistry: PaneCommandRegistry, context: SessionRunContext, loop: StoredLoop): Promise<LoopRunStart> {
  const { session, recovered } = await readyLoopSession(commandRegistry, loop);
  if (!recovered) return sendToLoopSession(commandRegistry, context, session, loop.initialInput ?? '');
  try {
    return { ...await sendToLoopSession(commandRegistry, context, session, loop.initialInput ?? ''), recovered };
  } catch (error) {
    const done = recovered.kind === 'restored' ? `restored the archived Session ${session.name}` : `made a new Session, ${session.name}`;
    throw new Error(`Pane ${done} for this run, but the prompt was not sent: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function sendToLoopSession(commandRegistry: PaneCommandRegistry, context: SessionRunContext, session: LoopSession, prompt: string): Promise<LoopRunStart> {
  if (!isLoopAgent(session.agent)) throw new Error(`Session ${session.name} runs ${agentLabel(session.agent)}, which loops cannot run yet, so the prompt was not sent. Point the loop at a ${loopAgentNames()} Session.`);
  const panelId = session.panelIds[session.agent];
  const { readiness } = decodeBoundary(await commandRegistry.invoke('runpane:panels:resume', [{ panelId, waitReady: true }]), panelResumeResultSchema);
  // Each warning is read later, so it says what was true when this run started.
  const held = (what: string, next: string) => ({ sessionId: null, warning: `When this run started, ${what}. The loop's prompt was not sent. ${next}` });
  if (readiness?.blocked) return held('the Session\'s agent was stopped at a prompt', 'Open the Session and answer it.');
  const ofKind = readiness !== undefined && readiness.state.running && readiness.state.agentType === session.agent;
  const working = readiness?.reason?.code === 'agent-not-ready' && readiness.state.activityStatus === 'active';
  if (!ofKind || !(readiness.ok || working)) {
    if (readiness?.reason?.code === 'command-exited') {
      const printed = PRINTED.exec(readiness.reason.message)?.[1];
      return held(`the Session's agent was not running: its launch command exited back to the shell${printed ? `, printing "${printed}"` : ''}`,
        'Open the Session, fix the agent\'s launch command, and start the agent again in its tab; the next run sends the prompt.');
    }
    return held('no ready agent was found in the Session\'s tab; its launch may have failed and left a plain shell',
      'Open the Session and start the agent again in its tab; the next run sends the prompt.');
  }
  // The flags a loop adds reach a running agent only when it starts again; Pane never restarts it under you.
  const launched = context.launchedCommand(panelId);
  if (launched !== undefined && missingUnattendedFlags(launched, session.agent).length > 0) {
    return held('the Session\'s agent was still running from before it was set to skip permission prompts',
      'Exit the agent in the Session\'s tab and start it again (it resumes the same conversation); the next run sends the prompt.');
  }
  const submitted = decodeBoundary(await commandRegistry.invoke('runpane:panels:submit', [{ panelId, input: prompt, source: 'agent', expectReport: false }]), panelSubmitResultSchema);
  if (submitted.ok) return { sessionId: null };
  return { sessionId: null, warning: 'When this run started, Pane could not confirm the Session\'s agent got the prompt. Open the Session to check whether it arrived.' };
}

/** The flags a built-in agent template launches with, such as `--yolo`. */
function unattendedFlags(agent: LoopAgent): string[] {
  return agentTerminalCommand(agent).trim().split(/\s+/).slice(1);
}

/** The program a built-in agent template runs, such as `cursor-agent`. */
function agentExecutable(agent: LoopAgent): string {
  return agentTerminalCommand(agent).trim().split(/\s+/)[0];
}

/**
 * The unattended flags a launched command lacks, read as shell words, so a flag
 * named inside a quoted argument does not count. A shell's `-c` command string
 * (as a WSL launch is wrapped) is read as words too. In an `agent-farm run`
 * launch, `--native-arg=<flag>` before Agent Farm's `--` counts as the flag.
 */
function missingUnattendedFlags(command: string, agent: LoopAgent): string[] {
  const words = tokenizeShellCommand(command, process.platform) ?? [];
  const nested = words.flatMap((word, index) => /^-[a-z]*c$/i.test(word) && words[index + 1] ? [tokenizeShellCommand(words[index + 1], process.platform) ?? []] : []);
  const all = new Set([words, ...nested].flatMap(givenFlags));
  return unattendedFlags(agent).filter(flag => !all.has(flag));
}

/** The words of one command as the flags its agent gets: Agent Farm's `--native-arg=<flag>` options become `<flag>`. */
function givenFlags(words: string[]): string[] {
  if (!isAgentFarmRunWords(words)) return words;
  const end = words.indexOf('--');
  const options = end < 0 ? words : words.slice(0, end);
  const forwarded = options.flatMap(word => word.startsWith(NATIVE_ARG) ? [word.slice(NATIVE_ARG.length)] : []);
  return end < 0 ? forwarded : [...forwarded, ...words.slice(end + 1)];
}

const NATIVE_ARG = '--native-arg=';

function isAgentFarmRunWords(words: string[]): boolean {
  return words.length > 1 && normalizeProcessName(words[0]) === 'agent-farm' && words[1] === 'run';
}

/**
 * A Session's custom launch command with the agent's unattended flags added
 * right after the agent's program. An `agent-farm run` launch gets them as
 * `--native-arg=<flag>` right after its profile (after `run` when options come
 * first), so the profile stays the word after `run`, where Session Move and chat
 * tabs read it. Only a plain invocation of the agent or of `agent-farm run` can
 * be changed safely: a wrapper (`sh -c`, `env`, a variable assignment) or a
 * compound command (`&&`, `;`, a pipe or redirect) is refused.
 */
function unattendedLaunchCommand(sessionName: string, command: string, agent: LoopAgent): string {
  const spans: Array<{ start: number; end: number }> = [];
  const words = tokenizeShellCommand(command, process.platform, spans) ?? [];
  const program = agentExecutable(agent);
  const agentFarm = isPlainAgentCommand(command, 'agent-farm') && isAgentFarmRunWords(words);
  if (!agentFarm && !isPlainAgentCommand(command, program)) {
    throw new PaneError(
      'ERR_LOOP_INVALID',
      `Session ${sessionName} launches its agent with \`${command}\`, which Pane cannot safely change to skip permission prompts. Nothing was saved.`,
      `Set the Session's launch command to a plain \`${program} …\` or \`agent-farm run …\` command with no wrapper or shell operators, or clear it to use the default, then save the loop again.`,
    );
  }
  const missing = missingUnattendedFlags(command, agent);
  if (missing.length === 0) return command;
  const end = spans[agentFarm ? (words[2] && !words[2].startsWith('-') ? 2 : 1) : 0].end;
  const added = agentFarm ? missing.map(flag => `${NATIVE_ARG}${flag}`) : missing;
  return `${command.slice(0, end)} ${added.join(' ')}${command.slice(end)}`;
}

/**
 * Resolve a Session loop's target and make its Session's agent run `agent`
 * without permission prompts, through `runpane sessions create` and
 * `sessions update`. A new Session, or one with no launch command, launches the
 * agent's built-in template; a custom one gets the missing flags added after
 * the agent's program. A running agent picks them up when it next starts;
 * until then runs are held (see `sendSessionLoopRun`).
 */
export async function prepareLoopSession(
  commandRegistry: PaneCommandRegistry,
  target: string,
  loop: { name: string; agent: LoopAgent },
  context: { isChatTab: (panelId: string) => boolean } = { isChatTab: () => false },
): Promise<string> {
  // An empty launch command means the template, whatever the app's default Session command is.
  const session = target === LOOP_NEW_SESSION
    ? await createLoopSession(commandRegistry, loop.name, loop.agent)
    : await getLoopSession(commandRegistry, target);
  if (session.archived) {
    throw new PaneError('ERR_LOOP_INVALID', `Session ${session.name} is archived. Nothing was saved.`, 'Restore the Session first, or pick another one.');
  }
  // An Agent Farm Session can already run its agent in a chat tab, which a loop cannot drive yet.
  const command = session.launchCommand?.trim() ?? '';
  if (isLoopAgent(session.agent) && session.agent === loop.agent && isAgentFarmRunWords(tokenizeShellCommand(command, process.platform) ?? [])
    && context.isChatTab(session.panelIds[session.agent])) {
    throw new PaneError(
      'ERR_LOOP_INVALID',
      `Session ${session.name} runs its Agent Farm agent in a chat tab, which loops cannot send prompts to yet. Nothing was saved.`,
      'Pick a Session whose agent runs in a terminal tab, or a new Session for this loop.',
    );
  }
  // A loop's Session lives under Loops, never in the pinned list.
  if (session.isPinned) {
    await commandRegistry.invoke('runpane:sessions:update', [{ selector: { sessionId: session.id }, input: { isPinned: false, source: 'user' } }]);
  }
  // Switching it to the loop's agent would drop its launch command without asking.
  if (!isLoopAgent(session.agent)) {
    throw new PaneError('ERR_LOOP_INVALID', `Session ${session.name} runs ${agentLabel(session.agent)}, which loops cannot run yet. Nothing was saved.`, `Pick a ${loopAgentNames()} Session, or a new Session for this loop.`);
  }
  // Changing the agent drops the old command, so the new agent launches its template.
  if (session.agent !== loop.agent) {
    await commandRegistry.invoke('runpane:sessions:update', [{ selector: { sessionId: session.id }, input: { agent: loop.agent, source: 'user' } }]);
  } else if (command) {
    const unattended = unattendedLaunchCommand(session.name, command, loop.agent);
    if (unattended !== command) {
      await commandRegistry.invoke('runpane:sessions:update', [{ selector: { sessionId: session.id }, input: { launchCommand: unattended, source: 'user' } }]);
    }
  }
  return session.id;
}

/** Archive an old run Pane the way `runpane panes archive` does. False when unfinished work (a busy agent, unsent input, or uncommitted or unpushed changes) blocked it. */
export async function archiveLoopRun(commandRegistry: PaneCommandRegistry, sessionId: string): Promise<boolean> {
  const result = decodeBoundary(await commandRegistry.invoke('runpane:panes:archive', [{ paneId: sessionId, source: 'agent' }]), paneArchiveResultSchema);
  return result.blocked === undefined;
}

/** The agents loops run, by label: `Claude, Codex or Cursor`. */
function loopAgentNames(): string {
  const labels = LOOP_AGENTS.map(agentLabel);
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
}
