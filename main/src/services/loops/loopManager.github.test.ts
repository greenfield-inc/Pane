import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopManager } from './loopManager';
import { LoopRepository } from './loopRepository';
import { createLoopTestDb } from './loopTestDb';
import type { GithubEventCandidate } from './githubLoopEvents';
import type { LoopGithubEvent, LoopInput } from '../../../../shared/types/loop';

const SAVED = Date.parse('2026-11-06T12:00:00Z');
const minute = 60_000;

const reviewer: LoopInput = {
  name: 'PR helper',
  projectId: 1,
  cron: '',
  agent: 'claude',
  initialInput: 'Address the request on this PR.',
  enabled: true,
  github: { repo: 'acme/app', commentPhrase: '/pane', changesRequested: true, checkFailed: true, prOpened: true, issueLabel: 'agent' },
};

function comment(id: number, overrides: Partial<LoopGithubEvent> = {}, collaborator = true): GithubEventCandidate {
  return {
    collaborator,
    event: {
      key: `comment:${id}`, kind: 'comment', repo: 'acme/app', number: id, isPr: true, url: `https://github.com/acme/app/pull/${id}#c`,
      author: 'maya', atMs: SAVED + minute, summary: 'Comment by @maya', text: '/pane please fix the test', headRef: `feature-${id}`, fork: false,
      ...overrides,
    },
  };
}

function setup() {
  let nowMs = SAVED;
  let candidates: GithubEventCandidate[] = [];
  const active = new Set<string>();
  const started: Array<{ sessionId: string; event?: LoopGithubEvent }> = [];
  const manager = new LoopManager({
    repo: new LoopRepository((() => { const db = createLoopTestDb(); return () => db; })()),
    startRun: async (_loop, _slot, event) => {
      const sessionId = `pane-${started.length + 1}`;
      started.push({ sessionId, event });
      return { sessionId };
    },
    archiveRun: async () => true,
    projectExists: id => id === 1,
    prepareSession: async target => target,
    githubEvents: { poll: async () => candidates },
    runActive: sessionId => active.has(sessionId),
    now: () => nowMs,
  });
  return {
    manager,
    started,
    active,
    feed: (next: GithubEventCandidate[]) => { candidates = next; },
    setNow: (ms: number) => { nowMs = ms; },
    runs: () => manager.list()[0].runs,
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('LoopManager GitHub events', () => {
  it('starts one run for a collaborator\'s /pane comment, with the event, however often the comment is seen', async () => {
    const t = setup();
    await t.manager.save(reviewer);
    t.setNow(SAVED + minute + 10_000);
    t.feed([comment(4)]);
    await t.manager.pollGithub();
    await t.manager.pollGithub();

    expect(t.started).toHaveLength(1);
    expect(t.started[0].event).toMatchObject({ key: 'comment:4', number: 4 });
    expect(t.runs()).toMatchObject([{ trigger: 'github', status: 'started', sessionId: 'pane-1', event: { key: 'comment:4' } }]);
  });

  it('lists why a comment without the phrase, a stranger\'s comment and a fork\'s PR start nothing', async () => {
    const t = setup();
    await t.manager.save(reviewer);
    t.setNow(SAVED + 2 * minute);
    t.feed([
      comment(1, { text: 'looks good to me' }),
      comment(2, { author: 'stranger', summary: 'Comment by @stranger' }, false),
      { collaborator: true, event: { key: 'pr:3', kind: 'pr', repo: 'acme/app', number: 3, isPr: true, url: 'u', author: 'forker', atMs: SAVED + minute, summary: 'Opened PR #3', fork: true } },
    ]);
    await t.manager.pollGithub();

    expect(t.started).toEqual([]);
    expect(t.runs().map(run => [run.status, run.event?.number, run.error])).toEqual(expect.arrayContaining([
      ['skipped', 1, 'The comment does not contain "/pane".'],
      ['skipped', 2, '@stranger is not a collaborator on acme/app, so their comment starts nothing.'],
      ['skipped', 3, 'PR #3 comes from a fork, and this loop does not run on forks.'],
    ]));
  });

  it('starts at most the hourly cap and lists the rest as skipped', async () => {
    const t = setup();
    await t.manager.save(reviewer);
    t.setNow(SAVED + 2 * minute);
    t.feed(Array.from({ length: 20 }, (_, index) => comment(index + 1)));
    await t.manager.pollGithub();

    expect(t.started).toHaveLength(12);
    const capped = t.manager.list()[0].runs.filter(run => run.status === 'skipped');
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.every(run => run.error === 'This loop already started 12 runs from GitHub in the last hour, its hourly cap. Use Run now to start this one anyway.')).toBe(true);
  });

  it('skips a comment on a PR whose run is still active, and Run now starts it', async () => {
    const t = setup();
    await t.manager.save(reviewer);
    t.setNow(SAVED + 2 * minute);
    t.feed([comment(4)]);
    await t.manager.pollGithub();
    t.active.add('pane-1');
    t.feed([comment(4, { key: 'comment:40', atMs: SAVED + 2 * minute })]);
    t.setNow(SAVED + 3 * minute);
    await t.manager.pollGithub();

    expect(t.started).toHaveLength(1);
    const skipped = t.runs().find(run => run.event?.key === 'comment:40');
    expect(skipped).toMatchObject({ status: 'skipped', error: 'A run is already active on this PR. Use Run now to start another.' });

    await t.manager.runEvent(skipped!.id);
    expect(t.started.map(run => run.event?.key)).toEqual(['comment:4', 'comment:40']);
  });

  it('lists an event older than the 15-minute grace as missed and never starts it on its own', async () => {
    const t = setup();
    await t.manager.save(reviewer);
    t.setNow(SAVED + 40 * minute);
    t.feed([comment(4)]);
    await t.manager.pollGithub();

    expect(t.started).toEqual([]);
    expect(t.runs()).toMatchObject([{ status: 'skipped', error: 'Missed while Pane was not running or the computer was asleep. Use Run now to start it.' }]);
  });

  it('ignores events from before the loop was saved, and events it does not watch', async () => {
    const t = setup();
    await t.manager.save({ ...reviewer, github: { repo: 'acme/app', issueLabel: 'agent' } });
    t.setNow(SAVED + 2 * minute);
    t.feed([comment(4, { atMs: SAVED - minute }), comment(5)]);
    await t.manager.pollGithub();
    expect(t.runs()).toEqual([]);
  });

  it('starts runs for a failing check, a changes-requested review, a new PR and a label', async () => {
    const t = setup();
    await t.manager.save(reviewer);
    t.setNow(SAVED + 2 * minute);
    const at = SAVED + minute;
    t.feed([
      { collaborator: true, event: { key: 'check:1', kind: 'check', repo: 'acme/app', number: 1, isPr: true, url: 'u', author: null, atMs: at, summary: 'Check "test" failed' } },
      { collaborator: true, reviewState: 'CHANGES_REQUESTED', event: { key: 'review:2', kind: 'review', repo: 'acme/app', number: 2, isPr: true, url: 'u', author: 'lee', atMs: at, summary: '@lee requested changes' } },
      { collaborator: true, reviewState: 'APPROVED', event: { key: 'review:9', kind: 'review', repo: 'acme/app', number: 9, isPr: true, url: 'u', author: 'lee', atMs: at, summary: 'Review by @lee', text: 'ship it' } },
      { collaborator: true, event: { key: 'pr:3', kind: 'pr', repo: 'acme/app', number: 3, isPr: true, url: 'u', author: 'maya', atMs: at, summary: 'Opened PR #3', fork: false } },
      { collaborator: true, label: 'Agent', event: { key: 'label:4', kind: 'label', repo: 'acme/app', number: 4, isPr: false, url: 'u', author: 'maya', atMs: at, summary: 'Labeled Agent' } },
    ]);
    await t.manager.pollGithub();
    expect(t.started.map(run => run.event?.key).sort()).toEqual(['check:1', 'label:4', 'pr:3', 'review:2']);
  });

  it('saves a loop that only starts from events, and refuses events on a Session loop', async () => {
    const t = setup();
    expect(await t.manager.save(reviewer)).toMatchObject({ cron: '', nextRunAtMs: null, scheduleText: 'On GitHub events in acme/app' });
    await expect(t.manager.save({ ...reviewer, projectId: undefined, orchestrationSessionId: 'session-1' }))
      .rejects.toThrow('GitHub events start runs in a project, so a Session loop cannot use them. Nothing was saved.');
    await expect(t.manager.save({ ...reviewer, github: { repo: 'acme/app' } }))
      .rejects.toThrow('Choose at least one GitHub event, or remove the GitHub trigger. Nothing was saved.');
    await expect(t.manager.save({ ...reviewer, github: undefined })).rejects.toThrow(/cron/i);
  });
});
