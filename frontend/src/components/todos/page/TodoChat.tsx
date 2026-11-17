import type { TodoDetail } from '../../../../../shared/types/todos';
import { ThreadComposer } from './thread/ThreadComposer';
import { TodoThread } from './thread/TodoThread';

export interface TodoChatProps {
  detail: TodoDetail;
  /** The approval shown over the split, if any: its card is ringed. */
  openApprovalId?: string;
  /** Approval cards and a run's "Waiting on you" open the approval. */
  onOpenApproval?: (id: string) => void;
  /** A link to an attachment in the thread opens it. */
  onOpenAttachment?: (attachmentId: number) => void;
}

/**
 * The to-do's thread (round 7, Linear-style): event lines and folds, agent run cards, comment cards
 * with replies, and approval cards. The pieces live in `./thread/`; the model in `shared/todoThread`.
 */
export function TodoChatTimeline(props: TodoChatProps) {
  return <TodoThread {...props} />;
}

/** The composer pinned under the thread: comments go to the orchestrator (or, on a sub-to-do, the "To" switch). */
export function TodoComposer({ detail }: { detail: TodoDetail }) {
  return <ThreadComposer detail={detail} />;
}
