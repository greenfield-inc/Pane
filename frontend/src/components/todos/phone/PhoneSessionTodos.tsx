import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useSessionTodoEntries } from '../../../stores/todosStore';
import { useNow } from '../../notify/useNow';
import { SkeletonSwap } from '../../ui/Skeleton';
import { PhoneTodoListSkeleton } from '../TodoSkeletons';
import { viewerZone } from '../snoozeTime';
import { SESSION_DONE_GROUP, sessionGroupFolded, sessionOpenCount, sessionTodoGroups, withSessionFold, type SessionFolds } from '../sessionTodosList';
import { PhoneGroupHeader, PhoneTodoRow } from './PhoneTodoList';
import { PHONE_ICON_BUTTON, PHONE_SCROLL, PhoneHeader, PhoneScreen } from './phoneParts';

/** The Session a To-dos list is narrowed to (T-23), as the web app opens it from that Session's header. */
export interface PhoneTodosSession {
  id: string;
  name: string;
}

interface PhoneSessionTodosProps {
  session: PhoneTodosSession;
  onOpen: (number: number) => void;
  onNew: () => void;
  /** Back to the Session. */
  onBack: () => void;
}

/**
 * A Session's to-dos on a phone (T-23): the desktop tab's list in the phone's rows, full screen with back
 * to the Session. The same groups; Snoozed and Done this week start folded. A tap opens the to-do's page.
 */
export function PhoneSessionTodos({ session, onOpen, onNew, onBack }: PhoneSessionTodosProps) {
  const entries = useSessionTodoEntries(session.id);
  const now = useNow();
  const zone = useMemo(viewerZone, []);
  const groups = useMemo(() => sessionTodoGroups(entries ?? [], now), [entries, now]);
  const [folds, setFolds] = useState<SessionFolds>({});
  return (
    <PhoneScreen testId="phone-session-todos">
      <PhoneHeader
        title={entries && entries.length > 0 ? `To-dos · ${sessionOpenCount(entries)} open` : 'To-dos'}
        back={{ label: session.name, onBack }}
        right={<button type="button" onClick={onNew} aria-label="New to-do" className={`needs-full-access ${PHONE_ICON_BUTTON}`} data-testid="phone-todos-new"><Plus className="h-5 w-5" aria-hidden="true" /></button>}
      />
      <div className={PHONE_SCROLL} role="list" aria-label={`${session.name} to-dos`} data-testid="phone-session-todos-scroll">
        <SkeletonSwap loading={entries === null} skeleton={<PhoneTodoListSkeleton />}>
          {entries && entries.length === 0 && (
            <div className="px-6 pt-12 text-center" data-testid="phone-session-todos-empty">
              <p className="text-[15px] font-semibold text-text-primary">No to-dos in this Session yet</p>
              <p className="mt-1 text-[13.5px] text-text-secondary">When the orchestrator plans work, its to-dos show here with their status and approvals.</p>
            </div>
          )}
          {groups.map((group) => {
            const folded = sessionGroupFolded(folds, group, groups.length);
            return (
              <div key={group.key} role="presentation">
                <PhoneGroupHeader group={group} folded={folded} now={now} zone={zone} onToggle={() => setFolds(current => withSessionFold(current, group.key, !folded))}
                  note={folded && group.key === SESSION_DONE_GROUP ? 'older ones in To-dos' : undefined} />
                {!folded && group.entries.map((entry) => <PhoneTodoRow key={entry.key} entry={entry} now={now} zone={zone} onOpen={onOpen} />)}
              </div>
            );
          })}
        </SkeletonSwap>
        <div className="h-[env(safe-area-inset-bottom)]" aria-hidden="true" />
      </div>
    </PhoneScreen>
  );
}
