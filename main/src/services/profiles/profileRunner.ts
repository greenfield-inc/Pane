import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { agentModelArgs, agentTerminalCommand, isConfiguredAgent } from '../../../../shared/agents';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import type { NotifyChoice } from '../../../../shared/types/notify';
import {
  type Profile,
  type ProfileAgentStep,
  type ProfileRun,
  type ProfileStep,
} from '../../../../shared/types/profiles';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { LOOP_GO_AGAIN, LOOP_STOP, answerCard, enterStep, reportOutcome, setOutcome, startRun, stepExited, stepLost, type RunEffect, type RunTransition } from './flowMachine';

/** How a step's shell keeps its command's exit code as its own, so the tab's exit carries it. */
export type StepShell = 'posix' | 'fish' | 'powershell' | 'cmd';

/** One step's terminal tab: the first step opens a new Pane, every later one is a tab in it. */
export interface StepTabRequest {
  run: ProfileRun;
  title: string;
  /** The line the tab runs: an agent CLI, or a command step's own command. */
  command: string;
  /** The configured agent the command starts, so Pane can tell when it is ready and type the first message. */
  agentType?: string;
  /** The first message, typed once the agent is ready. */
  initialInput?: string;
  /** Set for the first step: the Pane to create. */
  newPane?: { name: string };
}

/** A step's new tab, and the prompt it stopped at when its agent wasn't ready. */
export interface StartedTab {
  paneId: string;
  panelId: string;
  /** What the tab's screen asks, such as a folder-trust prompt; Pane never answers it for the person. */
  blocked?: string;
}

/** A card the run raises in Approvals. Resolves with its id at once; the answer comes from waitCard. */
export interface RunCard {
  id: string;
  run: ProfileRun;
  ui: 'options' | 'ask';
  title: string;
  context: string;
  choices?: NotifyChoice[];
}

export interface ProfileRunnerPorts {
  now(): string;
  /** The profile a run follows, as the library loads it now (valid and launchable), or undefined. */
  profile(name: string): Profile | undefined;
  /** The file an agent's `reads` id names, as a path the agent can open. */
  readPath(profile: Profile, id: string): string | undefined;
  /** The folder a Session's run files go in. */
  runsFolder(sessionId: string): string;
  /** Every Session's runs folder, read at start to resume runs. */
  allRunsFolders(): string[];
  shell(): StepShell;
  startTab(request: StepTabRequest): Promise<StartedTab>;
  /** Whether a tab still exists. */
  tabExists(panelId: string): boolean;
  postCard(card: RunCard): void;
  /** The answer to a card; undefined when it was closed without one. Waits across restarts by id. */
  waitCard(approvalId: string): Promise<string | undefined>;
  log(message: string): void;
}

export interface ProfileLaunchRequest {
  profile: string;
  repoId: number;
  sessionId: string;
  prompt: string;
  /** Agent id → `cli` or `cli/model`, over the file's `runs`. */
  harness?: Record<string, string>;
  /** A CLI Pane doesn't know → the command that starts it. */
  commands?: Record<string, string>;
}

const RUNS_FOLDER = 'profile-runs';
const runFileSchema = boundary.object({ id: boundary.nonEmptyString, profile: boundary.nonEmptyString, sessionId: boundary.nonEmptyString, state: boundary.string });

/** `<Session folder>/profile-runs`: one `<run id>.json` per run. */
export function profileRunsFolder(sessionFolder: string): string {
  return path.join(sessionFolder, RUNS_FOLDER);
}

/** A command step's line: the command, then an exit that keeps its exit code, so the tab's exit routes the step. */
export function commandStepLine(command: string, shell: StepShell): string {
  switch (shell) {
    case 'powershell': return `${command}; if ($?) { exit 0 } else { exit 1 }`;
    case 'cmd': return `${command} && exit 0 || exit 1`;
    case 'fish': return `${command}; exit $status`;
    case 'posix': return `${command}; exit $?`;
  }
}

/** The CLI, model and effort one step's agent runs with. */
interface ChosenRuns {
  cli: string;
  model?: string;
  effort?: string;
}

/** The agent's CLI and model for a step: the launch's choice over the file's `runs`. */
function chosenRuns(run: ProfileRun, profile: Profile, agentId: string): ChosenRuns {
  const agent = profile.agents.find((candidate) => candidate.id === agentId);
  const runs = run.harness[agentId] ?? agent?.runs ?? '';
  const slash = runs.indexOf('/');
  const cli = slash < 0 ? runs : runs.slice(0, slash);
  const result: ChosenRuns = { cli };
  // A model named at launch replaces the file's; switching CLI without one drops the file's model.
  const model = slash < 0 ? (run.harness[agentId] === undefined ? agent?.model : undefined) : runs.slice(slash + 1);
  if (model) result.model = model;
  if (agent?.effort) result.effort = agent.effort;
  return result;
}

/** The first message an agent step's tab gets: goal, what came before, files to read, and how to end the step. */
function stepMessage(run: ProfileRun, profile: Profile, step: ProfileAgentStep, readPaths: string[]): string {
  const agent = profile.agents.find((candidate) => candidate.id === step.agent);
  const previous = run.history.at(-1);
  const lines = [
    `Pane profile ${profile.name} ${profile.version}, step "${step.id}": you are the ${step.agent}.`,
    `Goal: ${step.goal}.`,
  ];
  if (run.history.length === 0) lines.push(`The request: ${run.prompt}`);
  else lines.push(`The request: ${run.prompt}`, `Previous step: ${previous?.step} › ${previous?.took ?? 'done'}${run.carry ? `: ${run.carry}` : ''}`);
  if (readPaths.length) lines.push(`Read first: ${readPaths.join(', ')}`);
  if (agent?.skills.length) lines.push(`Skills for this step: ${agent.skills.join(', ')}`);
  lines.push(
    `End this step by reporting exactly one of these outcomes: ${step.outcomes.map((edge) => `"${edge.name}"`).join(', ')}.`,
    `Report it with: "$PANE_RUNPANE_BIN" report --outcome "<outcome>" [--summary-file <file>] (PowerShell: & $env:PANE_RUNPANE_BIN report --outcome "<outcome>"). Pane then starts the next step.`,
  );
  return lines.join('\n');
}

/**
 * Runs profiles' workflows from their files (D-5). Each step is a terminal tab; an agent step
 * moves on when its agent reports a declared outcome, a command when its tab exits, an ask when
 * the person answers in Approvals. Each run is a JSON file in its Session's folder, written before
 * every move, so a restart picks up where it was and starts nothing twice.
 */
export class ProfileRunner {
  private readonly runs = new Map<string, ProfileRun>();
  /** Card ids this process already waits on, so a card is never waited on twice. */
  private readonly waiting = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly ports: ProfileRunnerPorts) {}

  /** Reads every run file and resumes the ones still going: waits on their cards again, asks about tabs that are gone. */
  async resumeAll(): Promise<void> {
    for (const folder of this.ports.allRunsFolders()) {
      let files: string[];
      try { files = fs.readdirSync(folder).filter((file) => file.endsWith('.json')); }
      catch { continue; }
      for (const file of files) {
        const run = this.readRunFile(path.join(folder, file));
        if (run) this.runs.set(run.id, run);
      }
    }
    for (const run of this.runs.values()) {
      if (run.state === 'ended' || run.state === 'failed') continue;
      await this.serialized(() => this.resume(run.id));
    }
  }

  list(): ProfileRun[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(runId: string): ProfileRun | undefined {
    return this.runs.get(runId);
  }

  /** Starts a run of a launchable profile; resolves once its first step's tab exists. */
  async launch(request: ProfileLaunchRequest): Promise<ProfileRun> {
    const profile = this.ports.profile(request.profile);
    if (!profile) throw new PaneError('PROFILE_NOT_LAUNCHABLE', `No valid profile named "${request.profile}" can be launched.`, 'Open Profiles to see its errors, or run `runpane profiles list`.');
    const now = this.ports.now();
    const run: ProfileRun = {
      id: randomUUID(),
      profile: profile.name,
      profileVersion: profile.version,
      sessionId: request.sessionId,
      repoId: request.repoId,
      prompt: request.prompt,
      harness: { ...request.harness },
      commands: { ...request.commands },
      state: 'running',
      step: profile.flow?.start ?? '',
      wait: { kind: 'none' },
      edgeCounts: {},
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.serialized(() => this.apply(run.id, profile, startRun(run, profile, now)));
    return this.mustGet(run.id);
  }

  /** `runpane report --outcome` from a step's tab. Throws when no run waits on the tab, or the outcome isn't declared. */
  async reportOutcome(panelId: string, outcome: string, summary?: string): Promise<ProfileRun> {
    const run = this.list().find((candidate) => candidate.wait.kind === 'step' && candidate.wait.panelId === panelId);
    if (!run) throw new PaneError('PROFILE_RUN_NONE', 'This tab is not the current step of any profile run, so --outcome has nothing to move.', 'Report with --state instead, or run the profile from Profiles.');
    const profile = this.profileOf(run);
    const transition = reportOutcome(run, profile, panelId, outcome, summary, this.ports.now());
    await this.serialized(() => this.apply(run.id, profile, transition));
    return this.mustGet(run.id);
  }

  /** A tab exited: moves the run whose current step it is. */
  async tabExited(panelId: string, exitCode: number | undefined): Promise<void> {
    const run = this.list().find((candidate) => candidate.wait.kind === 'step' && candidate.wait.panelId === panelId);
    if (!run) return;
    const profile = this.profileOf(run);
    const transition = stepExited(run, profile, panelId, exitCode, this.ports.now());
    if (transition) await this.serialized(() => this.apply(run.id, profile, transition));
  }

  /** "Set outcome…" on a run whose agent step is running. */
  async setOutcome(runId: string, outcome: string): Promise<ProfileRun> {
    const run = this.mustGet(runId);
    const profile = this.profileOf(run);
    await this.serialized(() => this.apply(runId, profile, setOutcome(run, profile, outcome, this.ports.now())));
    return this.mustGet(runId);
  }

  /** Ends a run where it is. Its tabs stay open. */
  async stop(runId: string): Promise<ProfileRun> {
    const run = this.mustGet(runId);
    if (run.state === 'ended' || run.state === 'failed') return run;
    const stopped: ProfileRun = { ...run, state: 'ended', wait: { kind: 'none' }, error: 'Stopped by you.', updatedAt: this.ports.now() };
    delete stopped.pending;
    await this.serialized(async () => this.save(stopped));
    return stopped;
  }

  private mustGet(runId: string): ProfileRun {
    const run = this.runs.get(runId);
    if (!run) throw new PaneError('PROFILE_RUN_MISSING', `No profile run ${runId}.`, 'List runs with `runpane profiles runs`.');
    return run;
  }

  private profileOf(run: ProfileRun): Profile {
    const profile = this.ports.profile(run.profile);
    if (!profile) throw new PaneError('PROFILE_NOT_LAUNCHABLE', `The profile ${run.profile} that run ${run.id} follows is no longer valid, so the run can't move.`, 'Fix the profile (Profiles shows its errors), then try again.');
    return profile;
  }

  /** One move at a time, so two events never race on one run file. */
  private serialized(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private readRunFile(file: string): ProfileRun | undefined {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!decodeOptionalBoundary(parsed, runFileSchema)) return undefined;
      // SAFETY: the file is one this runner wrote with JSON.stringify(ProfileRun); its identifying fields were checked above.
      return parsed as ProfileRun;
    } catch (error) {
      this.ports.log(`[Profiles] Skipped run file ${file}: ${reasonOf(error)}.`);
      return undefined;
    }
  }

  private save(run: ProfileRun): void {
    const folder = this.ports.runsFolder(run.sessionId);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${run.id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`);
    fs.renameSync(temporary, file);
    this.runs.set(run.id, run);
  }

  /** Saves the move first, then does its one effect, then saves what the effect made (a tab or a card). */
  private async apply(runId: string, profile: Profile, transition: RunTransition): Promise<void> {
    // A move leaves the old step's prompt behind, so what waited on the person there no longer does.
    let run: ProfileRun = { ...transition.run };
    delete run.attention;
    this.save(run);
    try {
      run = await this.perform(run, profile, transition.effect);
    } catch (error) {
      run = { ...run, state: 'failed', error: `${reasonOf(error)}.`, wait: { kind: 'none' }, updatedAt: this.ports.now() };
      this.ports.log(`[Profiles] Run ${runId} of ${profile.name} failed at ${run.step}: ${reasonOf(error)}`);
    }
    this.save(run);
  }

  private async perform(run: ProfileRun, profile: Profile, effect: RunEffect): Promise<ProfileRun> {
    switch (effect.kind) {
      case 'none': return run;
      case 'start-step': {
        const { paneId, panelId, blocked } = await this.ports.startTab(this.tabFor(run, profile, effect.step));
        const started: ProfileRun = { ...run, paneId: run.paneId ?? paneId, wait: { kind: 'step', panelId } };
        if (blocked) started.attention = `Step ${effect.step.id}'s tab is waiting at a prompt: "${blocked}". Open the tab and answer it; the step's first message is typed once the agent is ready.`;
        return started;
      }
      case 'ask': {
        const step = effect.step;
        const context = [`${profile.name} run, step ${step.id}.`, run.carry ? `Before this: ${run.carry}` : ''].filter(Boolean).join(' ');
        const card: RunCard = step.next !== undefined
          ? { id: randomUUID(), run, ui: 'ask', title: step.ask, context }
          : { id: randomUUID(), run, ui: 'options', title: step.ask, context, choices: step.choices.map((edge, index) => ({ label: edge.name, detail: `Goes to ${edge.to}.`, recommended: index === 0 })) };
        return this.raise(run, profile, card, 'ask');
      }
      case 'ask-loop':
        return this.raise(run, profile, {
          id: randomUUID(), run, ui: 'options',
          title: `This loop ran ${effect.times} times: go again, or stop?`,
          context: `${profile.name} took ${effect.from} › ${effect.took} ${effect.times} times in this run.`,
          choices: [
            { label: LOOP_GO_AGAIN, detail: `Takes ${effect.from} › ${effect.took} once more; the count starts over.`, recommended: true },
            { label: LOOP_STOP, detail: 'Ends the run here. Its tabs stay open.' },
          ],
        }, 'loop');
      case 'ask-outcome':
        return this.raise(run, profile, {
          id: randomUUID(), run, ui: 'options',
          title: `Which outcome did ${effect.step.id} have?`,
          context: `The ${effect.step.kind === 'agent' ? `${effect.step.agent}'s tab closed before it reported` : 'command\'s tab ended while Pane could not see it'}, so the run waits for you.`,
          choices: effect.step.outcomes.map((edge, index) => ({ label: edge.name, detail: `Goes to ${edge.to}.`, recommended: index === 0 })),
        }, 'set-outcome');
    }
  }

  private raise(run: ProfileRun, profile: Profile, card: RunCard, kind: 'ask' | 'loop' | 'set-outcome'): ProfileRun {
    this.ports.postCard(card);
    const next: ProfileRun = { ...run, wait: { kind: 'card', approvalId: card.id, card: kind } };
    this.listen(next.id, card.id, profile.name);
    return next;
  }

  /** Waits for a card's answer in the background, then moves the run. */
  private listen(runId: string, approvalId: string, profileName: string): void {
    if (this.waiting.has(approvalId)) return;
    this.waiting.add(approvalId);
    void this.ports.waitCard(approvalId).then(async (answer) => {
      this.waiting.delete(approvalId);
      const run = this.runs.get(runId);
      if (!run || run.wait.kind !== 'card' || run.wait.approvalId !== approvalId) return;
      if (answer === undefined) {
        this.ports.log(`[Profiles] The approval for ${profileName} run ${runId} closed without an answer; the run waits.`);
        return;
      }
      const profile = this.profileOf(run);
      await this.serialized(() => this.apply(runId, profile, answerCard(run, profile, approvalId, answer, this.ports.now())));
    }).catch((error) => {
      this.waiting.delete(approvalId);
      this.ports.log(`[Profiles] Run ${runId}: ${reasonOf(error)}`);
    });
  }

  private async resume(runId: string): Promise<void> {
    const run = this.mustGet(runId);
    const profile = this.ports.profile(run.profile);
    if (!profile) {
      this.ports.log(`[Profiles] Run ${run.id} follows ${run.profile}, which is not valid now; it waits until the profile is fixed.`);
      return;
    }
    if (run.wait.kind === 'card' && run.wait.approvalId) {
      this.listen(run.id, run.wait.approvalId, profile.name);
      return;
    }
    if (run.wait.kind === 'card' || (run.wait.kind === 'step' && !run.wait.panelId)) {
      // Pane stopped between saving a move and doing it: do it now, once.
      await this.apply(run.id, profile, { run, effect: this.unfinishedEffect(run, profile) });
      return;
    }
    if (run.wait.kind === 'step' && !this.ports.tabExists(run.wait.panelId)) {
      const lost = stepLost(run, profile, this.ports.now());
      if (lost) await this.apply(run.id, profile, lost);
    }
  }

  /** The effect a saved move still owes: its tab or card was never made. */
  private unfinishedEffect(run: ProfileRun, profile: Profile): RunEffect {
    const step = profile.flow?.steps.find((candidate) => candidate.id === run.step);
    if (run.wait.kind === 'card' && run.wait.card === 'loop' && run.pending) return { kind: 'ask-loop', from: run.pending.from, took: run.pending.took, times: profile.loopLimit };
    if (run.wait.kind === 'card' && run.wait.card === 'set-outcome' && step && step.kind !== 'ask') return { kind: 'ask-outcome', step };
    return enterStep(run, profile, run.step, this.ports.now()).effect;
  }

  private tabFor(run: ProfileRun, profile: Profile, step: ProfileAgentStep | Extract<ProfileStep, { kind: 'command' }>): StepTabRequest {
    const request: StepTabRequest = { run, title: '', command: '' };
    if (!run.paneId) request.newPane = { name: `${profile.name} ${run.prompt}`.slice(0, 60).trim() };
    if (step.kind === 'command') {
      request.title = step.title;
      request.command = commandStepLine(step.run, this.ports.shell());
      return request;
    }
    const chosen = chosenRuns(run, profile, step.agent);
    const reads = (profile.agents.find((agent) => agent.id === step.agent)?.reads ?? []).flatMap((id) => this.ports.readPath(profile, id) ?? []);
    request.title = `${step.agent} · ${step.id}`;
    request.initialInput = stepMessage(run, profile, step, reads);
    if (isConfiguredAgent(chosen.cli)) {
      request.command = [agentTerminalCommand(chosen.cli), ...agentModelArgs(chosen.cli, chosen.model, chosen.effort)].join(' ');
      request.agentType = chosen.cli;
    } else {
      // Baseline: a CLI Pane doesn't know runs as the command the launch gave for it, in a plain terminal.
      request.command = run.commands[chosen.cli] ?? chosen.cli;
    }
    return request;
  }
}
