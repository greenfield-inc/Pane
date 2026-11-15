import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { TerminalStateEmulator } from '../terminalStateEmulator';
import { detectAgentState } from './manifestEngine';
import { getManifestForAgent } from './manifests';
import { terminalMidTurn, SCREEN_FRESH_MS } from './midTurn';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

// Real Claude Code and Codex screens (recorded by scripts/agent-screens/capture.mjs), replayed
// byte for byte with their timing through the real pipeline: the terminal emulator, the agent's
// manifest, and the Session's mid-turn test, polled every 500 ms as the host polls.

const fixtureSchema = boundary.object({
  agent: boundary.enumeration('claude', 'codex'),
  version: boundary.string,
  cols: boundary.number,
  rows: boundary.number,
  frames: boundary.array(boundary.object({ t: boundary.number, data: boundary.string })),
  marks: boundary.array(boundary.object({ t: boundary.number, label: boundary.string })),
});
type Fixture = ReturnType<typeof fixtureSchema.decode>;

const load = (name: string): Fixture => decodeBoundary(JSON.parse(readFileSync(path.join(__dirname, '__fixtures__', 'screens', `${name}.json`), 'utf8')), fixtureSchema);
const markAt = (fixture: Fixture, label: string): number => {
  const mark = fixture.marks.find(entry => entry.label === label);
  if (!mark) throw new Error(`no mark ${label}`);
  return mark.t;
};

const POLL_MS = 500;

/** Each poll's mid-turn answer, from 0 to `until` (default: the last frame, plus `holdMs` of silence). */
async function replay(fixture: Fixture, options: { stopAt?: number; holdMs?: number } = {}): Promise<Array<{ t: number; midTurn: boolean; rule: string | null }>> {
  const emulator = new TerminalStateEmulator(fixture.cols, fixture.rows);
  const frames = fixture.frames.filter(frame => frame.t < (options.stopAt ?? Infinity));
  const end = (options.stopAt ?? (fixture.frames.at(-1)?.t ?? 0)) + (options.holdMs ?? 0);
  const manifest = getManifestForAgent(fixture.agent);
  const polls: Array<{ t: number; midTurn: boolean; rule: string | null }> = [];
  let index = 0;
  let last = '';
  let screenChangedAt: number | undefined;
  for (let t = 0; t <= end; t += POLL_MS) {
    while (index < frames.length && frames[index].t <= t) emulator.write(frames[index++].data);
    await emulator.waitForIdle();
    const input = { screen: emulator.getScreenText(), oscTitle: emulator.getOscTitle(), oscProgress: emulator.getOscProgress() };
    const key = `${input.oscTitle}\n${input.screen}`;
    if (key !== last) { screenChangedAt = t; last = key; }
    const detection = detectAgentState(manifest, input);
    polls.push({ t, midTurn: terminalMidTurn({ agentKnown: true, detection, screenChangedAt, waiting: false }, t), rule: detection.matchedRuleId });
  }
  emulator.dispose();
  return polls;
}

const between = (polls: Awaited<ReturnType<typeof replay>>, from: number, to: number) => polls.filter(poll => poll.t >= from && poll.t <= to);
const states = (polls: Awaited<ReturnType<typeof replay>>) => [...new Set(polls.map(poll => poll.midTurn))];
/** The longest unbroken mid-turn stretch, in ms: under 10 s never spins a Session. */
const longestMidTurn = (polls: Awaited<ReturnType<typeof replay>>) => {
  let longest = 0;
  let since: number | undefined;
  for (const poll of polls) {
    if (poll.midTurn) { since ??= poll.t; longest = Math.max(longest, poll.t - since); }
    else since = undefined;
  }
  return longest;
};

describe('real screens through the Session mid-turn test', () => {
  it('Claude: thinking and a long silent Bash call count throughout; the prompt before and after does not', async () => {
    const fixture = load('claude-long-bash');
    const polls = await replay(fixture);
    expect(states(between(polls, 0, markAt(fixture, 'turn-start')))).toEqual([false]);
    // The whole turn, the 45 s Bash call included, with no dip: the title spinner keeps animating.
    expect(states(between(polls, markAt(fixture, 'turn-start') + 1500, markAt(fixture, 'turn-end') - 1500))).toEqual([true]);
    expect(states(between(polls, markAt(fixture, 'turn-end') + 1500, markAt(fixture, 'idle-after')))).toEqual([false]);
  }, 60_000);

  it('Claude: compacting counts as working', async () => {
    const fixture = load('claude-long-bash');
    const polls = await replay(fixture);
    const compacting = between(polls, markAt(fixture, 'compact-start') + 1500, markAt(fixture, 'compact-end') - 1500);
    expect(compacting.length).toBeGreaterThan(0);
    expect(states(compacting)).toEqual([true]);
  }, 60_000);

  it('Claude: a frozen spinner stops counting 15 s after the screen last changed', async () => {
    const fixture = load('claude-long-bash');
    const stopAt = markAt(fixture, 'bash-mid');
    const polls = await replay(fixture, { stopAt, holdMs: 30_000 });
    const lastFrame = Math.max(...fixture.frames.filter(frame => frame.t < stopAt).map(frame => frame.t));
    const lastChangePoll = Math.ceil(lastFrame / POLL_MS) * POLL_MS;
    expect(states(between(polls, lastChangePoll, lastChangePoll + SCREEN_FRESH_MS - POLL_MS))).toEqual([true]);
    expect(states(between(polls, lastChangePoll + SCREEN_FRESH_MS, stopAt + 30_000))).toEqual([false]);
  }, 60_000);

  it('Claude: a permission prompt is not mid-turn', async () => {
    const fixture = load('claude-permission');
    const polls = await replay(fixture);
    const prompt = between(polls, markAt(fixture, 'permission') + 1000, markAt(fixture, 'dismissed'));
    expect(new Set(prompt.map(poll => poll.rule))).not.toContain(null);
    expect(states(prompt)).toEqual([false]);
  }, 60_000);

  it('Claude: typing into an idle prompt and a selection menu are not mid-turn', async () => {
    const fixture = load('claude-menu-typing');
    expect(states(await replay(fixture))).toEqual([false]);
  }, 60_000);

  it('Claude: an API retry counts as working while it retries', async () => {
    const fixture = load('claude-api-retry');
    const polls = await replay(fixture, { holdMs: 5_000 });
    expect(states(between(polls, markAt(fixture, 'retrying') + 1000, markAt(fixture, 'interrupted') - 500))).toEqual([true]);
    expect(states(between(polls, markAt(fixture, 'interrupted') + 2000, markAt(fixture, 'interrupted') + 4000))).toEqual([false]);
  }, 60_000);

  it('Codex: a long silent command counts throughout; the composer after does not', async () => {
    const fixture = load('codex-long-command');
    const polls = await replay(fixture, { holdMs: 5_000 });
    // Codex animates its title for a few seconds while it boots: too short to spin a Session.
    expect(longestMidTurn(between(polls, 0, markAt(fixture, 'turn-start')))).toBeLessThan(5_000);
    expect(states(between(polls, markAt(fixture, 'idle'), markAt(fixture, 'turn-start')))).toEqual([false]);
    expect(states(between(polls, markAt(fixture, 'working') + 1500, markAt(fixture, 'turn-end') - 1500))).toEqual([true]);
    expect(states(between(polls, markAt(fixture, 'turn-end') + 2000, markAt(fixture, 'turn-end') + 4500))).toEqual([false]);
  }, 60_000);

  it('Codex: typing into the composer and an approval prompt are not mid-turn', async () => {
    const fixture = load('codex-approval-typing');
    const polls = await replay(fixture);
    // Typing starts while Codex still boots (its title spinner); the stretch stays far under 10 s.
    expect(longestMidTurn(between(polls, 0, markAt(fixture, 'turn-start')))).toBeLessThan(5_000);
    expect(states(between(polls, markAt(fixture, 'typing') + 2000, markAt(fixture, 'typed')))).toEqual([false]);
    expect(states(between(polls, markAt(fixture, 'approval') + 1000, markAt(fixture, 'dismissed')))).toEqual([false]);
  }, 60_000);
});
