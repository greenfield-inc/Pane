import { describe, expect, it } from 'vitest';
import type { NotifyItem } from '../../../../shared/types/notify';
import { machineOfItem, todoKey, todoKeyOfItem, todoKeyOfRow, todoRefOn } from '../../../../shared/todoKey';
import { sessionTodoMachine } from '../../stores/todosStore';

function card(machineId?: string, number?: number): NotifyItem {
  const made: NotifyItem = { id: 'q', ui: 'options', title: 'q', state: 'waiting', createdAt: 1, source: { name: 'agent', agent: 'Agent' } };
  if (machineId) made.machineId = machineId;
  if (number) made.todo = { number, title: 'T' };
  return made;
}

describe('TodoKey (T-51)', () => {
  it('names a to-do by its machine and number', () => {
    expect(todoKey('macbook', 28)).toBe('macbook:28');
    expect(todoKey('macbook', 28)).not.toBe(todoKey('local', 28));
  });

  it('a card\'s key is its machine\'s, this computer\'s when it names none; a card with no to-do has none', () => {
    expect(todoKeyOfItem(card('macbook', 28))).toBe(todoKey('macbook', 28));
    expect(todoKeyOfItem(card(undefined, 28))).toBe(todoKey('local', 28));
    expect(todoKeyOfItem(card('macbook'))).toBeUndefined();
    expect(machineOfItem(card())).toBe('local');
  });

  it('a row\'s key is the machine it was read from', () => {
    expect(todoKeyOfRow('macbook', { todo: { number: 28 } })).toBe(todoKey('macbook', 28));
  });

  it('another machine\'s to-do reads with the machine beside it', () => {
    expect(todoRefOn(28)).toBe('T-28');
    expect(todoRefOn(28, 'tylers-macbook-pro')).toBe('T-28 · tylers-macbook-pro');
  });
});

describe('which machine a Session\'s to-dos are on (T-51)', () => {
  it('the machine named, else the computer this window shows', () => {
    expect(sessionTodoMachine(undefined, 'local')).toBe('local');
    expect(sessionTodoMachine(undefined, 'devbox')).toBe('devbox');
    // All machines names each row's machine: this computer's row stays this computer while the window shows another.
    expect(sessionTodoMachine('local', 'devbox')).toBe('local');
    expect(sessionTodoMachine('macbook', 'local')).toBe('macbook');
  });
});
