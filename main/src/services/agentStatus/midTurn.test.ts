import { describe, expect, it } from 'vitest';
import { chatMidTurn, RunpaneWaits, terminalMidTurn, SCREEN_FRESH_MS, CHAT_STALL_MS } from './midTurn';
import type { AgentDetectionResult } from '../../../../shared/types/agentStatus';

const detection = (partial: Partial<AgentDetectionResult>): AgentDetectionResult => ({
  state: 'idle',
  visibleBlocker: false,
  visibleWorking: false,
  visibleIdle: false,
  skipStateUpdate: false,
  matchedRuleId: null,
  ...partial,
});

const working = detection({ state: 'working', visibleWorking: true, matchedRuleId: 'osc_title_spinner' });

describe('terminalMidTurn', () => {
  it('counts working chrome while the screen keeps changing', () => {
    expect(terminalMidTurn({ agentKnown: true, detection: working, screenChangedAt: 1_000, waiting: false }, 5_000)).toBe(true);
  });

  it('stops counting 15 s after the screen last changed, even with the chrome still up (a frozen spinner)', () => {
    expect(SCREEN_FRESH_MS).toBe(15_000);
    const input = { agentKnown: true, detection: working, screenChangedAt: 0, waiting: false };
    expect(terminalMidTurn(input, 14_999)).toBe(true);
    expect(terminalMidTurn(input, 15_000)).toBe(false);
  });

  it('never counts output alone: no working chrome is not mid-turn', () => {
    expect(terminalMidTurn({ agentKnown: true, detection: detection({ state: 'idle' }), screenChangedAt: 4_900, waiting: false }, 5_000)).toBe(false);
  });

  it('never counts a plain shell, even when its screen says working', () => {
    expect(terminalMidTurn({ agentKnown: false, detection: working, screenChangedAt: 4_900, waiting: false }, 5_000)).toBe(false);
  });

  it('never counts a blocked screen', () => {
    const blocked = detection({ state: 'blocked', visibleBlocker: true, matchedRuleId: 'permission' });
    expect(terminalMidTurn({ agentKnown: true, detection: blocked, screenChangedAt: 4_900, waiting: false }, 5_000)).toBe(false);
  });

  it('never counts a tab waiting on runpane', () => {
    expect(terminalMidTurn({ agentKnown: true, detection: working, screenChangedAt: 4_900, waiting: true }, 5_000)).toBe(false);
  });

  it('does not count a screen it has never seen change', () => {
    expect(terminalMidTurn({ agentKnown: true, detection: working, screenChangedAt: undefined, waiting: false }, 5_000)).toBe(false);
  });
});

describe('chatMidTurn', () => {
  const base = { status: 'working' as const, lastUpdateAt: 0, toolRunning: false, waiting: false };

  it('counts an open prompt that is still sending updates', () => {
    expect(chatMidTurn(base, 60_000)).toBe(true);
  });

  it('stops counting a turn with no update for 5 minutes and no tool running', () => {
    expect(CHAT_STALL_MS).toBe(5 * 60_000);
    expect(chatMidTurn(base, CHAT_STALL_MS - 1)).toBe(true);
    expect(chatMidTurn(base, CHAT_STALL_MS)).toBe(false);
  });

  it('keeps counting a silent turn while a tool call is running', () => {
    expect(chatMidTurn({ ...base, toolRunning: true }, CHAT_STALL_MS * 3)).toBe(true);
  });

  it('honours a shorter stall limit when one is given', () => {
    expect(chatMidTurn(base, 2_000, 1_000)).toBe(false);
  });

  it('never counts starting, blocked, idle or stopped', () => {
    for (const status of ['starting', 'blocked', 'idle', 'stopped'] as const) {
      expect(chatMidTurn({ ...base, status }, 1_000)).toBe(false);
    }
  });

  it('never counts a chat waiting on runpane', () => {
    expect(chatMidTurn({ ...base, waiting: true }, 1_000)).toBe(false);
  });

  it('does not count a turn that has sent no update yet as stalled before the limit', () => {
    expect(chatMidTurn({ ...base, lastUpdateAt: undefined, turnStartedAt: 0 }, 1_000)).toBe(true);
    expect(chatMidTurn({ ...base, lastUpdateAt: undefined, turnStartedAt: 0 }, CHAT_STALL_MS)).toBe(false);
  });
});

describe('RunpaneWaits', () => {
  it('marks a tab waiting while a call is open and clears it when the call ends', () => {
    const waits = new RunpaneWaits();
    const end = waits.begin('p');
    expect(waits.isWaiting('p')).toBe(true);
    end();
    expect(waits.isWaiting('p')).toBe(false);
  });

  it('keeps a tab waiting until every overlapping call has ended, and ignores a second end', () => {
    const waits = new RunpaneWaits();
    const a = waits.begin('p');
    const b = waits.begin('p');
    a();
    a();
    expect(waits.isWaiting('p')).toBe(true);
    b();
    expect(waits.isWaiting('p')).toBe(false);
  });

  it('ignores calls with no caller tab', () => {
    const waits = new RunpaneWaits();
    waits.begin(undefined)();
    expect(waits.isWaiting('p')).toBe(false);
  });
});
