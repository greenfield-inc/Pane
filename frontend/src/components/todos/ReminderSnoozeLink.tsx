import { Moon } from 'lucide-react';
import { useTodosStore } from '../../stores/todosStore';

/**
 * Under a reminder card's four answers (round 9, T-17): "Snooze to another time…" opens the to-do
 * with its snooze menu, since a card can't hold a date picker. Hand to an agent is explained here.
 */
export function ReminderSnoozeLink({ number }: { number: number }) {
  const open = () => {
    useTodosStore.getState().requestSnooze(number);
    // Loaded on use: the approval column stays free of the app's navigation (its tests run without storage).
    void import('./todosNavigation').then(({ openTodo }) => openTodo(number));
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
