import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import { cn } from '../utils/cn';
import { sessionIsUnread } from '../../../shared/sessionUnread';

interface SessionNameProps {
  name: string;
  session: Pick<OrchestrationSessionRecord, 'readState'>;
  className?: string;
}

/**
 * A Session's name in a sidebar row: bold only while its agent has a message the person has not
 * read (sessionIsUnread), regular weight otherwise. Every Session list uses it so they agree.
 */
export function SessionName({ name, session, className }: SessionNameProps) {
  const unread = sessionIsUnread(session);
  return (
    <span
      data-unread={unread || undefined}
      className={cn('min-w-0 flex-1 truncate text-[13px] text-text-primary', unread && 'font-semibold', className)}
    >
      {name}
    </span>
  );
}
