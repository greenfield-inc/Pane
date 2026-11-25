import { describe, expect, it } from 'vitest';
import type { TodoShownStatus } from '../../../../../shared/types/todos';
import { todoForSession, type SessionTodoRow } from './todoSessionLink';

function row(number: number, title: string, sessionId: string | null, status: TodoShownStatus = 'working'): SessionTodoRow {
  return { todo: { number, ref: `T-${number}`, title, sessionId }, status: { status } };
}

const rows = [row(12, 'Invoice PDFs', 's-12', 'waiting'), row(14, 'Attach PDF to the receipt email', null), row(20, 'Tax ID', 's-20')];

describe('todoForSession', () => {
  it('finds the to-do whose Session this is', () => {
    expect(todoForSession({ id: 's-12' }, rows, 'local', null)).toEqual({ number: 12, ref: 'T-12', title: 'Invoice PDFs', status: 'waiting', cameFrom: false });
  });

  it('is null for a Session no to-do owns', () => {
    expect(todoForSession({ id: 'billing' }, rows, 'local', null)).toBeNull();
    expect(todoForSession({ id: 'billing' }, undefined, 'local', null)).toBeNull();
  });

  it('reads the record’s own to-do number before the to-dos snapshot arrives', () => {
    expect(todoForSession({ id: 's-30', todoNumber: 30 }, undefined, 'local', null)).toEqual({ number: 30, ref: 'T-30', cameFrom: false });
    expect(todoForSession({ id: 's-30', todoNumber: 12 }, rows, 'local', null)).toMatchObject({ number: 12, title: 'Invoice PDFs' });
  });

  it('returns to the to-do you came from, a sub-to-do on its parent’s Session included', () => {
    expect(todoForSession({ id: 's-12' }, rows, 'local', { machineId: 'local', sessionId: 's-12', number: 14 })).toEqual({
      number: 14, ref: 'T-14', title: 'Attach PDF to the receipt email', status: 'working', cameFrom: true,
    });
    expect(todoForSession({ id: 's-12' }, rows, 'local', { machineId: 'local', sessionId: 's-12', number: 12 })).toMatchObject({ number: 12, cameFrom: true });
  });

  it('ignores where you came from when it was another Session', () => {
    expect(todoForSession({ id: 's-12' }, rows, 'local', { machineId: 'local', sessionId: 's-20', number: 20 })).toMatchObject({ number: 12, cameFrom: false });
    expect(todoForSession({ id: 'billing' }, rows, 'local', { machineId: 'local', sessionId: 's-20', number: 20 })).toBeNull();
  });

  it('ignores where you came from on another machine, even in a Session with the same id (review F-4)', () => {
    // A sub-to-do's Session opened on the mini; this computer has a Session with the same id (a copied database).
    const fromMini = { machineId: 'mini', sessionId: 's-12', number: 14 };
    expect(todoForSession({ id: 's-12' }, rows, 'local', fromMini)).toMatchObject({ number: 12, title: 'Invoice PDFs', cameFrom: false });
    expect(todoForSession({ id: 's-12' }, rows, 'mini', fromMini)).toMatchObject({ number: 14, cameFrom: true });
  });
});
