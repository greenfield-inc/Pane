import { LOCAL_MACHINE_ID } from './types/machineConnections';
import type { NotifyItem } from './types/notify';
import { todoRef, type TodoRecord } from './types/todos';

/**
 * One to-do, anywhere (T-51): the machine it is on and its number there. Every machine numbers its
 * own to-dos T-1, T-2 and so on, so two machines each have a T-28, and a number alone says nothing
 * once two machines' cards or rows meet. Built only here, so a bare number can't stand in for one.
 *
 * The machine is the viewer's own id for it: `local` for this computer, else the saved machine's id,
 * which a saved machine's cards and to-do rows both carry. Never the hostname, which drifts.
 */
export type TodoKey = string & { readonly todoKey: unique symbol };

export function todoKey(machineId: string, number: number): TodoKey {
  // SAFETY: the one place a TodoKey is made; the brand keeps every other string out.
  return `${machineId}:${number}` as TodoKey;
}

/** The machine a card came from: its saved machine's id, else this computer. */
export function machineOfItem(item: Pick<NotifyItem, 'machineId'>): string {
  return item.machineId ?? LOCAL_MACHINE_ID;
}

/** The to-do a card is linked to, on the machine the card came from; none when it names none. */
export function todoKeyOfItem(item: Pick<NotifyItem, 'machineId' | 'todo'>): TodoKey | undefined {
  return item.todo ? todoKey(machineOfItem(item), item.todo.number) : undefined;
}

/** A to-do row read from machine `machineId`. */
export function todoKeyOfRow(machineId: string, row: { todo: Pick<TodoRecord, 'number'> }): TodoKey {
  return todoKey(machineId, row.todo.number);
}

/** "T-28", or "T-28 · tylers-macbook-pro" for another machine's, by the name it is saved under. */
export function todoRefOn(number: number, machineLabel?: string): string {
  return machineLabel ? `${todoRef(number)} · ${machineLabel}` : todoRef(number);
}
