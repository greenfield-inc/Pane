import { describe, expect, it } from 'vitest';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { isTodoSession, visibleOrchestrationSessions } from './orchestrationSessionVisibility';

function session(id: string, extra: Partial<OrchestrationSessionRecord> = {}): OrchestrationSessionRecord {
  // SAFETY: the filter reads only id, archived, todoNumber and isPinned.
  return { id, name: id, archived: false, associations: [], ...extra } as OrchestrationSessionRecord;
}

const NONE: ReadonlySet<string> = new Set();
const ids = (list: readonly OrchestrationSessionRecord[]) => list.map(item => item.id);

describe('visibleOrchestrationSessions', () => {
  it('hides a to-do\'s Session the moment its record exists, before any to-dos snapshot (the creation race, T-7)', () => {
    const sessions = [session('plain'), session('todo', { todoNumber: 26 })];
    expect(ids(visibleOrchestrationSessions(sessions, { todoSessionIds: NONE }))).toEqual(['plain']);
  });

  it('hides a to-do\'s Session even while it is the open one; another open Session still shows', () => {
    const sessions = [session('todo', { todoNumber: 26 }), session('old-todo'), session('loop')];
    const loops = new Set(['loop']);
    expect(ids(visibleOrchestrationSessions(sessions, { todoSessionIds: NONE, openSessionId: 'todo' }))).toEqual(['old-todo', 'loop']);
    expect(ids(visibleOrchestrationSessions(sessions, { todoSessionIds: new Set(['old-todo']), openSessionId: 'old-todo', loopSessionIds: loops }))).toEqual([]);
    expect(ids(visibleOrchestrationSessions(sessions, { todoSessionIds: NONE, openSessionId: 'loop', loopSessionIds: loops }))).toEqual(['old-todo', 'loop']);
  });

  it('falls back to the snapshot\'s ids for a to-do Session made before records carried the number', () => {
    expect(ids(visibleOrchestrationSessions([session('old-todo'), session('plain')], { todoSessionIds: new Set(['old-todo']) }))).toEqual(['plain']);
  });

  it('keeps a to-do\'s Session out even with a card waiting; a loop\'s joins while one waits', () => {
    const sessions = [session('todo', { todoNumber: 3 }), session('loop')];
    const waiting = () => 1;
    expect(ids(visibleOrchestrationSessions(sessions, { todoSessionIds: NONE, loopSessionIds: new Set(['loop']), waitingCount: waiting }))).toEqual(['loop']);
    expect(ids(visibleOrchestrationSessions(sessions, { todoSessionIds: NONE, loopSessionIds: new Set(['loop']) }))).toEqual([]);
  });

  it('leaves archived Sessions out', () => {
    expect(visibleOrchestrationSessions([session('gone', { archived: true })], { todoSessionIds: NONE, openSessionId: 'gone' })).toEqual([]);
  });
});

describe('isTodoSession', () => {
  it('reads the record first and the snapshot ids second', () => {
    expect(isTodoSession(session('a', { todoNumber: 1 }), NONE)).toBe(true);
    expect(isTodoSession(session('a'), new Set(['a']))).toBe(true);
    expect(isTodoSession(session('a'), NONE)).toBe(false);
  });
});
