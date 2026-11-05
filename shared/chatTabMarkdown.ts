import { describeChatContent } from './agentChatPresentation';
import { imageOf, type ChatTurn, type StepGroup, type TurnItem } from './chatTabPresentation';

/**
 * A chat as Markdown, for the copy buttons (D-140): a message, a response's text, or the
 * conversation with speaker labels. In the conversation, tool steps become one short line
 * each, the way the chat shows them, never their raw output.
 */

const DONE = { explore: 'Explored', edit: 'Edited', run: 'Ran', think: 'Thought', other: 'Used' } satisfies Record<StepGroup['kind'], string>;

/** A code span that survives backticks inside it. */
function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return text.includes('`') ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function stepLine(group: StepGroup): string {
  const single = group.steps.length === 1 ? group.steps[0] : undefined;
  const failed = group.steps.some(step => step.status === 'failed') ? ' (failed)' : '';
  if (group.kind === 'run' && single?.command) return `- ${DONE.run} ${code(single.command)}${failed}`;
  if (group.kind === 'edit') {
    const counts = group.added || group.removed ? ` (+${group.added} −${group.removed})` : '';
    return `- ${DONE.edit} ${code(group.steps[0].path ?? group.label)}${counts}${failed}`;
  }
  return `- ${DONE[group.kind]} ${group.label}${group.detail ? `: ${group.detail}` : ''}${failed}`;
}

function itemMarkdown(item: TurnItem): string {
  switch (item.type) {
    case 'text': return item.text.trim();
    case 'thought': return '';
    case 'image': return '[Image]';
    case 'steps': return item.groups.map(stepLine).join('\n');
    case 'plan': return ['To-do:', ...item.entries.map(entry => `- [${entry.status === 'completed' ? 'x' : ' '}] ${entry.content}`)].join('\n');
    case 'content': return `[${describeChatContent(item.content).label}]`;
  }
}

/** What the person wrote, with an attached image as "[Image]". */
export function userMarkdown(turn: ChatTurn): string {
  return (turn.user?.parts ?? []).flatMap(part => {
    if (part.type === 'text') return part.text.trim() ? [part.text.trim()] : [];
    return part.type === 'content' && imageOf(part.content) ? ['[Image]'] : [];
  }).join('\n\n');
}

/** What the agent wrote in a turn, without its activity (D-182): what per-message Copy copies. */
export function responseText(turn: ChatTurn): string {
  return turn.items.flatMap(item => item.type === 'text' && item.text.trim() ? [item.text.trim()] : []).join('\n\n');
}

/** A turn's whole response for the conversation: its text, its steps one line each, and its to-do list. */
function responseWithActivity(turn: ChatTurn): string {
  return turn.items.map(itemMarkdown).filter(Boolean).join('\n\n');
}

/** The conversation, each message under its speaker. */
export function conversationMarkdown(turns: readonly ChatTurn[], agent: string): string {
  return turns.flatMap(turn => {
    const sections: string[] = [];
    const user = userMarkdown(turn);
    const response = responseWithActivity(turn);
    if (user) sections.push(`**You:**\n\n${user}`);
    if (response) sections.push(`**${agent}:**\n\n${response}`);
    return sections;
  }).join('\n\n');
}
