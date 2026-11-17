/** Placeholder until the to-do page lands; the To-dos screen renders it for a selected to-do. */
export interface TodoPageProps {
  number: number;
  /** Back to the list (Esc, or the "To-dos" breadcrumb). */
  onBack: () => void;
  /** Open another to-do's page (a sub-to-do, or the parent from the breadcrumb). */
  onOpenTodo: (number: number) => void;
}

export function TodoPage({ number }: TodoPageProps) {
  return <div data-testid="todo-page" data-todo={number} />;
}
