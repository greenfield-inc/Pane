import { Moon } from 'lucide-react';
import type { NotifyItem } from '../../../../shared/types/notify';
import { machineOfItem, todoKey } from '../../../../shared/todoKey';
import { todoRef } from '../../../../shared/types/todos';
import { useTodosStore } from '../../stores/todosStore';
import { shownHostId, useConfigStore } from '../../stores/configStore';

/**
 * Under a reminder card's four answers (round 9, T-17): "Snooze to another time…" opens the to-do
 * with its snooze menu, since a card can't hold a date picker. Hand to an agent is explained here.
 * Another machine's reminder opens its to-do there (T-51), never this computer's with that number.
 */
export function ReminderSnoozeLink({ item }: { item: NotifyItem }) {
  const open = () => {
    if (!item.todo) return;
    const { number, title } = item.todo;
    const machine = machineOfItem(item);
    useTodosStore.getState().requestSnooze(todoKey(machine, number));
    // Loaded on use: the approval column stays free of the app's navigation (its tests run without storage).
    if (machine === shownHostId(useConfigStore.getState().config)) void import('./todosNavigation').then(({ openTodo }) => openTodo(number));
    else void import('../../utils/machineRowActions').then(({ openOnMachine }) => openOnMachine(machine, { kind: 'todo', id: number, name: `${todoRef(number)} ${title}` }));
  };
  return (
    <div className="mt-3" data-testid="approval-reminder">
      <button type="button" onClick={open} className="inline-flex items-center gap-1.5 text-[13.5px] text-interactive-text hover:underline" data-testid="approval-reminder-snooze">
        <Moon className="h-3.5 w-3.5" aria-hidden="true" />
        Snooze to another time…
      </button>
      <p className="mt-3 text-[13px] leading-relaxed text-text-secondary">
        <b className="font-semibold text-text-primary">Hand to an agent</b> starts it: Pane makes its Session and an orchestrator, and the note becomes its first instruction.
      </p>
    </div>
  );
}
