import type { NotifyItem, NotifySharedState, NotifyUi } from '@shared/types/notify';

/** The desktop card's kind labels (frontend/src/components/notify/notifyFormat.ts). */
export const NOTIFY_KIND_LABEL = {
  options: 'Needs a choice',
  approve: 'Needs approval',
  ask: 'Needs an answer',
  info: 'Update',
} satisfies Record<NotifyUi, string>;

export type NotifySheetState =
  | { kind: 'question'; item: NotifyItem }
  /** Nothing left to answer here; `message` says why. */
  | { kind: 'closed'; message: string };

/** What the sheet shows for a question in the host's snapshot. */
export function notifySheetState(item: NotifyItem | undefined): NotifySheetState {
  if (!item) return { kind: 'closed', message: 'This question is no longer waiting.' };
  switch (item.state) {
    case 'waiting':
      return { kind: 'question', item };
    case 'sent':
    case 'answered':
      return { kind: 'closed', message: `Already answered on ${item.answeredOn ?? 'another screen'}` };
    case 'expired':
      return { kind: 'closed', message: `${item.source.agent} stopped waiting` };
    case 'info':
      return { kind: 'closed', message: 'This is an update. There is nothing to answer.' };
  }
}

/** Questions still waiting for an answer, oldest first. */
export function waitingQuestions(state: NotifySharedState | undefined): NotifyItem[] {
  return (state?.items ?? []).filter(item => item.state === 'waiting').sort((a, b) => a.createdAt - b.createdAt);
}
