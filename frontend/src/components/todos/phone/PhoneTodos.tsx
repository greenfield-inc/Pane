import type { ReactNode } from 'react';
import { PhoneTodoApproval } from './PhoneTodoApproval';
import { PhoneTodoFiles } from './PhoneTodoFiles';
import { PhoneTodoForm, type PhoneTodoChoices } from './PhoneTodoForm';
import { PhoneTodoList } from './PhoneTodoList';
import { PhoneTodoPage } from './PhoneTodoPage';
import type { PhoneTodosRoute } from './phoneRoute';

export interface PhoneTodosProps {
  route: PhoneTodosRoute;
  /** Opens another screen: a new history entry. */
  onNavigate: (route: PhoneTodosRoute) => void;
  /** Changes the screen in place (a tab, the pager): no new entry. */
  onReplace: (route: PhoneTodosRoute) => void;
  /** Back one screen (header back, Android back, browser back all land here or in the history). */
  onBack: () => void;
  /** New to-do's repos, agents and machine. */
  choices: PhoneTodoChoices;
  /** The list's left slot: the app's menu. */
  listLead?: ReactNode;
  onOpenSession?: (sessionId: string) => void;
}

/**
 * To-dos on a phone (P7, D-422): one column, one screen at a time. The list, a to-do, its files and
 * an approval full screen, and the New to-do and New sub-to-do forms over them. The app owns the
 * route, so each screen is a history entry.
 */
export function PhoneTodos({ route, onNavigate, onReplace, onBack, choices, listLead, onOpenSession }: PhoneTodosProps) {
  // The form opens over the screen it came from, which stays underneath.
  const base: PhoneTodosRoute = route.screen === 'new' ? { screen: 'list' } : route.screen === 'new-sub' ? { screen: 'todo', number: route.number } : route;
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="phone-todos" data-screen={route.screen}>
      <Screen route={base} onNavigate={onNavigate} onReplace={onReplace} onBack={onBack} listLead={listLead} onOpenSession={onOpenSession} />
      {route.screen === 'new' && <PhoneTodoForm choices={choices} onCancel={onBack} onCreated={() => onBack()} />}
      {route.screen === 'new-sub' && <PhoneTodoForm parentNumber={route.number} choices={choices} onCancel={onBack} onCreated={() => onBack()} />}
    </div>
  );
}

type ScreenProps = Omit<PhoneTodosProps, 'choices'>;

function Screen({ route, onNavigate, onReplace, onBack, listLead, onOpenSession }: ScreenProps) {
  switch (route.screen) {
    case 'todo':
      return <TodoScreen number={route.number} onNavigate={onNavigate} onBack={onBack} onOpenSession={onOpenSession} />;
    case 'files':
      return <PhoneTodoFiles number={route.number} tab={route.tab} onTab={(tab) => onReplace({ screen: 'files', number: route.number, tab })} onBack={onBack} />;
    case 'approval':
      return <PhoneTodoApproval number={route.number} id={route.id} onSelect={(id) => onReplace({ screen: 'approval', number: route.number, id })} onBack={onBack} />;
    default:
      return <PhoneTodoList lead={listLead} onOpen={(number) => onNavigate({ screen: 'todo', number })} onNew={() => onNavigate({ screen: 'new' })} />;
  }
}

interface TodoScreenProps {
  number: number;
  onNavigate: (route: PhoneTodosRoute) => void;
  onBack: () => void;
  onOpenSession?: (sessionId: string) => void;
}

function TodoScreen({ number, onNavigate, onBack, onOpenSession }: TodoScreenProps) {
  return (
    <PhoneTodoPage
      key={number}
      number={number}
      onBack={onBack}
      onOpenTodo={(next) => onNavigate({ screen: 'todo', number: next })}
      onOpenFiles={(tab) => onNavigate({ screen: 'files', number, tab })}
      onOpenApproval={(id) => onNavigate({ screen: 'approval', number, id })}
      onAddSubTodo={() => onNavigate({ screen: 'new-sub', number })}
      onOpenSession={onOpenSession}
    />
  );
}
