import type { NotifyAnswer, NotifyItem } from './types/notify';

/**
 * Autopilot's decision card (D-75, D-77, D-91): the same card on the desktop chat and the phone
 * chat. This is its content; each surface draws it. Pure, so both renderers share it.
 */
export interface DecisionOption {
  key: string;
  label: string;
  /** One line under the label: what choosing it does. */
  detail?: string;
  recommended: boolean;
  answer: NotifyAnswer;
}

export interface DecisionModel {
  id: string;
  kind: 'Approval' | 'Question' | 'Permission' | 'Autopilot' | 'Stuck';
  /** The Q-n the asker put at the start of its title, when it did. */
  qn?: string;
  /** The question, without its Q-n. */
  title: string;
  session?: string;
  /** Who asked: the asking Pane (an orchestrator's planner, a worker), or Autopilot. */
  who: string;
  /** The one-line why under the question. */
  why?: string;
  /** Recommended first; answering one sends its `answer`. */
  options: DecisionOption[];
  /** An open question: a typed answer is the main way to answer. */
  freeText: boolean;
  byAutopilot: boolean;
  /** The collapsible context's label: "Why I'm asking" on Autopilot's own items. */
  contextLabel: string;
  state: NotifyItem['state'];
  answerSummary?: string;
  /** A stuck worker's question waits on its orchestrator: it takes no answer here. */
  answerable: boolean;
  createdAt: number;
}

/** A leading Q-n, or a range or list of them (Q-1–3, Q-4-6, Q-7, Q-8), then its separator. */
const QN = /^\s*(Q-\d+(?:(?:[–—-]|\s*[,/&]\s*)(?:Q-)?\d+)*)\s*[:·.–—-]?\s*/;

export function decisionModel(item: NotifyItem): DecisionModel {
  const match = QN.exec(item.title);
  const byAutopilot = item.source.autopilot === true;
  const kind: DecisionModel['kind'] = byAutopilot ? 'Autopilot' : item.relay ? 'Stuck' : item.agentPrompt ? 'Permission' : item.ui === 'approve' ? 'Approval' : 'Question';
  const model: DecisionModel = {
    id: item.id,
    kind,
    title: match ? item.title.slice(match[0].length) : item.title,
    // A Session orchestrator's own Pane is hidden (its name is "Session: …"), so it is named by its role.
    who: byAutopilot ? 'Autopilot' : item.relay?.worker ?? (item.source.session?.orchestrator ? 'orchestrator' : item.source.name),
    options: options(item),
    freeText: item.ui === 'ask',
    byAutopilot,
    contextLabel: byAutopilot ? "Why I'm asking" : 'More context',
    state: item.state,
    // A prompt whose agent stopped waiting on Pane can only be answered in its terminal now.
    answerable: !item.relay && !item.agentPrompt?.inTerminal && item.state === 'waiting',
    createdAt: item.createdAt,
  };
  if (match) model.qn = match[1];
  if (item.source.session) model.session = item.source.session.name;
  if (item.context) model.why = item.context;
  if (item.answerSummary) model.answerSummary = item.answerSummary;
  return model;
}

function options(item: NotifyItem): DecisionOption[] {
  if (item.ui === 'approve') {
    return [
      { key: 'approve', label: 'Approve', recommended: true, answer: { approved: true } },
      { key: 'deny', label: 'Deny', recommended: false, answer: { approved: false } },
    ];
  }
  if (item.ui === 'ask') {
    return (item.suggestions ?? []).map((text, index) => ({ key: `suggestion-${index}`, label: text, recommended: false, answer: { text } }));
  }
  const choices = (item.choices ?? []).map((choice, index) => {
    const option: DecisionOption = { key: `choice-${index}`, label: choice.label, recommended: choice.recommended === true, answer: { choice: choice.label } };
    if (choice.detail) option.detail = choice.detail;
    return option;
  });
  // A permission prompt keeps its own order (Yes, then No); a question lists the recommended one first.
  if (item.agentPrompt) return choices;
  return [...choices.filter(choice => choice.recommended), ...choices.filter(choice => !choice.recommended)];
}
