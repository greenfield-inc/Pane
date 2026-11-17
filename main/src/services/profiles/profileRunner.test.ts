import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Profile } from '../../../../shared/types/profiles';
import { loadProfiles } from './profileLoader';
import { ProfileRunner, commandStepLine, profileRunsFolder, type ProfileRunnerPorts, type RunCard, type StepTabRequest } from './profileRunner';

const FIXTURES = path.join(__dirname, '../../../../shared/profiles/fixtures');
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function greenfield(): Profile {
  const [loaded] = loadProfiles([{ file: path.join(FIXTURES, 'greenfield.profile.yaml'), origin: 'bundled' }]);
  if (!loaded.profile) throw new Error('fixture did not load');
  return loaded.profile;
}

/** A Pane stand-in: records tabs and cards; cards are answered with `answer(id, text)`. */
class FakePane {
  readonly sessionFolder = mkdtempSync(path.join(tmpdir(), 'pane-profile-run-'));
  readonly tabs: StepTabRequest[] = [];
  readonly cards: RunCard[] = [];
  readonly closedTabs = new Set<string>();
  private readonly answers = new Map<string, (answer: string | undefined) => void>();
  private tabCount = 0;

  constructor(private readonly profile: Profile = greenfield()) {
    temporary.push(this.sessionFolder);
  }

  ports(): ProfileRunnerPorts {
    return {
      now: () => '2026-11-17T08:00:00.000Z',
      profile: (name) => (name === this.profile.name ? this.profile : undefined),
      readPath: (_profile, id) => `/plugins/greenfield/instructions/${id}.md`,
      runsFolder: () => profileRunsFolder(this.sessionFolder),
      allRunsFolders: () => [profileRunsFolder(this.sessionFolder)],
      shell: () => 'posix',
      startTab: async (request) => {
        this.tabs.push(request);
        this.tabCount += 1;
        return { paneId: 'pane-1', panelId: `tab-${this.tabCount}` };
      },
      tabExists: (panelId) => !this.closedTabs.has(panelId) && Number(panelId.slice(4)) <= this.tabCount,
      postCard: (card) => { this.cards.push(card); },
      waitCard: (id) => new Promise((resolve) => { this.answers.set(id, resolve); }),
      log: () => undefined,
    };
  }

  answer(card: RunCard, text: string | undefined): void {
    this.answers.get(card.id)?.(text);
  }

  runFile(): string {
    const folder = profileRunsFolder(this.sessionFolder);
    return readFileSync(path.join(folder, readdirSync(folder)[0]), 'utf8');
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function launchRequest() {
  return { profile: 'greenfield', repoId: 1, sessionId: 's1', prompt: 'Export invoices as CSV' };
}

describe('ProfileRunner', () => {
  it('opens the first step in a new Pane with its CLI, model and first message', async () => {
    const pane = new FakePane();
    const run = await new ProfileRunner(pane.ports()).launch(launchRequest());
    expect(run).toMatchObject({ state: 'running', step: 'plan', paneId: 'pane-1', wait: { kind: 'step', panelId: 'tab-1' } });
    const [tab] = pane.tabs;
    expect(tab.newPane?.name).toBe('greenfield Export invoices as CSV');
    expect(tab.command).toContain('--model claude-opus-5-5');
    expect(tab.initialInput).toContain('Goal: Turn the request into a plan.');
    expect(tab.initialInput).toContain('The request: Export invoices as CSV');
    expect(tab.initialInput).toContain('"plan ready", "needs you"');
    expect(tab.initialInput).toContain('report --outcome "<outcome>"');
    expect(tab.initialInput).toContain('/plugins/greenfield/instructions/standing-rules.md');
    expect(JSON.parse(pane.runFile())).toMatchObject({ id: run.id, step: 'plan', wait: { panelId: 'tab-1' } });
  });

  it('runs the reviewer on the CLI the launch picked, and a CLI Pane doesn\'t know as its own command', async () => {
    const pane = new FakePane();
    const runner = new ProfileRunner(pane.ports());
    await runner.launch({ ...launchRequest(), harness: { planner: 'aider' }, commands: { aider: 'node ./stub-agent.js' } });
    expect(pane.tabs[0]).toMatchObject({ command: 'node ./stub-agent.js' });
    expect(pane.tabs[0].agentType).toBeUndefined();
  });

  it('turns needs you into an Approvals card, then starts the planner again with the answer, in the same Pane', async () => {
    const pane = new FakePane();
    const runner = new ProfileRunner(pane.ports());
    await runner.launch(launchRequest());
    const asking = await runner.reportOutcome('tab-1', 'needs you', 'Q-1: Include refunded invoices?');
    expect(asking).toMatchObject({ state: 'asking', step: 'answer', wait: { kind: 'card', card: 'ask' } });
    expect(pane.cards[0]).toMatchObject({ ui: 'ask', title: 'Answer the planner\'s question' });
    expect(pane.cards[0].context).toContain('Q-1: Include refunded invoices?');
    pane.answer(pane.cards[0], 'Exclude refunds.');
    await settle();
    expect(runner.list()[0]).toMatchObject({ step: 'plan', state: 'running', wait: { panelId: 'tab-2' } });
    expect(pane.tabs[1].newPane).toBeUndefined();
    expect(pane.tabs[1].initialInput).toContain('Previous step: answer › answered: Exclude refunds.');
  });

  it('approve starts the implementer as a tab in the same Pane', async () => {
    const pane = new FakePane();
    const runner = new ProfileRunner(pane.ports());
    await runner.launch(launchRequest());
    await runner.reportOutcome('tab-1', 'plan ready');
    expect(pane.cards[0]).toMatchObject({ ui: 'options', title: 'Approve the plan?', choices: [{ label: 'approve', recommended: true }, { label: 'change it' }] });
    pane.answer(pane.cards[0], 'approve');
    await settle();
    expect(runner.list()[0]).toMatchObject({ step: 'build', wait: { kind: 'step', panelId: 'tab-2' } });
    expect(pane.tabs[1]).toMatchObject({ title: 'implementer · build' });
  });

  it('refuses an undeclared outcome, listing the allowed ones, and the run does not move', async () => {
    const pane = new FakePane();
    const runner = new ProfileRunner(pane.ports());
    await runner.launch(launchRequest());
    await expect(runner.reportOutcome('tab-1', 'finished')).rejects.toMatchObject({ code: 'PROFILE_OUTCOME_UNKNOWN', message: expect.stringContaining('"plan ready", "needs you"') });
    expect(runner.list()[0]).toMatchObject({ step: 'plan', wait: { panelId: 'tab-1' } });
    await expect(runner.reportOutcome('no-run-tab', 'plan ready')).rejects.toMatchObject({ code: 'PROFILE_RUN_NONE' });
  });

  it('routes a command step by its tab\'s exit code', async () => {
    const pane = new FakePane();
    const runner = new ProfileRunner(pane.ports());
    await runner.launch(launchRequest());
    await runner.reportOutcome('tab-1', 'plan ready');
    pane.answer(pane.cards[0], 'approve');
    await settle();
    await runner.reportOutcome('tab-2', 'PR ready');
    expect(pane.tabs[2]).toMatchObject({ title: 'CI + QA checks', command: 'gh pr checks --watch; exit $?' });
    await runner.tabExited('tab-3', 1);
    expect(runner.list()[0]).toMatchObject({ step: 'build', wait: { panelId: 'tab-4' } });
  });

  it('picks up after a restart: the same step, nothing started twice, and its later report still moves the run', async () => {
    const pane = new FakePane();
    await new ProfileRunner(pane.ports()).launch(launchRequest());
    const restarted = new ProfileRunner(pane.ports());
    await restarted.resumeAll();
    expect(pane.tabs).toHaveLength(1);
    expect(restarted.list()[0]).toMatchObject({ step: 'plan', wait: { panelId: 'tab-1' } });
    await restarted.reportOutcome('tab-1', 'plan ready');
    expect(restarted.list()[0].step).toBe('approve');
    expect(pane.cards).toHaveLength(1);
  });

  it('waits on the same card after a restart, without posting it again', async () => {
    const pane = new FakePane();
    const first = new ProfileRunner(pane.ports());
    await first.launch(launchRequest());
    await first.reportOutcome('tab-1', 'plan ready');
    const restarted = new ProfileRunner(pane.ports());
    await restarted.resumeAll();
    expect(pane.cards).toHaveLength(1);
    pane.answer(pane.cards[0], 'approve');
    await settle();
    expect(restarted.list()[0].step).toBe('build');
  });

  it('asks for the outcome when the step\'s tab is gone after a restart', async () => {
    const pane = new FakePane();
    await new ProfileRunner(pane.ports()).launch(launchRequest());
    pane.closedTabs.add('tab-1');
    const restarted = new ProfileRunner(pane.ports());
    await restarted.resumeAll();
    expect(pane.cards[0]).toMatchObject({ title: 'Which outcome did plan have?', choices: [{ label: 'plan ready' }, { label: 'needs you' }] });
    pane.answer(pane.cards[0], 'needs you');
    await settle();
    expect(restarted.list()[0].step).toBe('answer');
  });

  it('can set an outcome by hand and stop a run', async () => {
    const pane = new FakePane();
    const runner = new ProfileRunner(pane.ports());
    const run = await runner.launch(launchRequest());
    expect((await runner.setOutcome(run.id, 'plan ready')).step).toBe('approve');
    expect(await runner.stop(run.id)).toMatchObject({ state: 'ended', error: 'Stopped by you.' });
  });

  it('marks the run failed, with the reason, when a step\'s tab can\'t start', async () => {
    const pane = new FakePane();
    const ports = pane.ports();
    const runner = new ProfileRunner({ ...ports, startTab: async () => { throw new Error('the repository is gone'); } });
    expect(await runner.launch(launchRequest())).toMatchObject({ state: 'failed', error: 'the repository is gone.' });
  });

  it('notes a step whose tab stopped at a prompt, and drops the note once the run moves on', async () => {
    const pane = new FakePane();
    const ports = pane.ports();
    const prompt = 'Quick safety check: Is this a project you created or one you trust?';
    const runner = new ProfileRunner({ ...ports, startTab: async (request) => ({ ...(await ports.startTab(request)), blocked: prompt }) });
    const run = await runner.launch(launchRequest());
    expect(run.attention).toBe('Step plan\'s tab is waiting at the agent\'s folder-trust prompt in its new worktree. Open the tab and answer it, or trust the project folder in the agent once; the step starts when the agent is ready.');
    expect((await runner.reportOutcome('tab-1', 'plan ready')).attention).toBeUndefined();
  });

  it('takes a report that arrives while its step\'s tab is still starting', async () => {
    const pane = new FakePane();
    const ports = pane.ports();
    let finishStart: () => void = () => undefined;
    const runner = new ProfileRunner({ ...ports, startTab: async (request) => {
      const started = await ports.startTab(request);
      // The agent is already running and reports before Pane has finished waiting for it to be ready.
      if (started.panelId === 'tab-1') await new Promise<void>((resolve) => { finishStart = resolve; });
      return started;
    } });
    const launched = runner.launch(launchRequest());
    await settle();
    const reported = runner.reportOutcome('tab-1', 'plan ready');
    finishStart();
    await launched;
    expect((await reported).step).toBe('approve');
  });

  it('refuses a profile that is not loaded', async () => {
    const runner = new ProfileRunner(new FakePane().ports());
    await expect(runner.launch({ ...launchRequest(), profile: 'orchestra' })).rejects.toMatchObject({ code: 'PROFILE_NOT_LAUNCHABLE' });
  });
});

describe('commandStepLine', () => {
  it('keeps the command\'s exit code as the shell\'s own, in each shell', () => {
    expect(commandStepLine('gh pr checks --watch', 'posix')).toBe('gh pr checks --watch; exit $?');
    expect(commandStepLine('gh pr checks --watch', 'fish')).toBe('gh pr checks --watch; exit $status');
    expect(commandStepLine('gh pr checks --watch', 'powershell')).toBe('gh pr checks --watch; if ($?) { exit 0 } else { exit 1 }');
    expect(commandStepLine('gh pr checks --watch', 'cmd')).toBe('gh pr checks --watch && exit 0 || exit 1');
  });
});
