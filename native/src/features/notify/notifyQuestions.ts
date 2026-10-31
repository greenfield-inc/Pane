import type { NotifyItem, NotifySharedState, NotifyUi } from '@shared/types/notify';

/** The desktop card's kind labels (frontend/src/components/notify/notifyFormat.ts). */
export const NOTIFY_KIND_LABEL = {
  options: 'Needs a choice',
  approve: 'Needs approval',
  ask: 'Needs an answer',
  info: 'Update',
} satisfies Record<NotifyUi, string>;

/** This phone's answer, from the moment the host accepted it: the snapshot it was answered over. */
export interface AnsweredHere {
  epoch: string;
  revision: number;
}

export type NotifySheetState =
  | { kind: 'question'; item: NotifyItem }
  /** An answer every screen holds for Undo; `title` says who answered. */
  | { kind: 'held'; title: string; summary?: string }
  /** This phone's answer reached the agent, so the sheet closes. */
  | { kind: 'done'; title: string; summary?: string }
  /** Nothing left to answer here; `message` says why. */
  | { kind: 'closed'; message: string };

/**
 * What the sheet shows for a question, from the host's snapshot. Until a snapshot newer than
 * `answeredHere` arrives, this phone's answer reads as sent; after that the host's state decides.
 */
export function notifySheetState(shared: NotifySharedState, notifyId: string, answeredHere: AnsweredHere | null): NotifySheetState {
  const item = shared.items.find(candidate => candidate.id === notifyId);
  if (!item) return { kind: 'closed', message: 'This question is no longer waiting.' };
  const sentTo = `Sent to ${item.source.agent}`;
  switch (item.state) {
    case 'waiting': {
      if (item.agentPrompt?.inTerminal) return { kind: 'closed', message: inTerminalMessage(item) };
      const olderThanAnswer = answeredHere !== null && shared.epoch === answeredHere.epoch && shared.revision <= answeredHere.revision;
      return olderThanAnswer ? { kind: 'held', title: sentTo } : { kind: 'question', item };
    }
    case 'sent':
      return { kind: 'held', title: answeredHere ? sentTo : `Answered on ${item.answeredOn ?? 'another screen'}`, summary: item.answerSummary };
    case 'answered':
      return answeredHere
        ? { kind: 'done', title: sentTo, summary: item.answerSummary }
        : { kind: 'closed', message: `Already answered on ${item.answeredOn ?? 'another screen'}` };
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

/** An agent prompt whose agent stopped waiting on Pane: only its terminal can answer it now. */
export function inTerminalMessage(item: NotifyItem): string {
  return `${item.source.agent} is asking in the terminal now. Open the Pane to answer.`;
}
