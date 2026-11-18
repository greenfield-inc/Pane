import type { TodoAttachment, TodoAttachmentGroup, TodoRecord } from '../../../../shared/types/todos';

/**
 * Every line Pane types into an agent's tab for a to-do. Tabs read these as plain text, so each
 * names where it came from in brackets and the command to answer with.
 */

function attachmentLine(attachment: TodoAttachment, from?: string): string {
  const where = attachment.machine ? `${attachment.target} (on ${attachment.machine})` : attachment.target;
  return `- ${attachment.kind}: ${attachment.label} — ${where}${from ? ` [from ${from}]` : ''}${attachment.note ? ` — ${attachment.note}` : ''}`;
}

/** The attachments block every starting message carries: own first, then inherited. */
function attachmentsBlock(groups: readonly TodoAttachmentGroup[]): string {
  const lines = groups.flatMap(group => group.attachments.map(attachment => attachmentLine(attachment, group.from ? `T-${group.from.number}` : undefined)));
  if (lines.length === 0) return 'Attachments: none yet. Attach every plan, mock-up, design, PR, findings file and decision page you produce or rely on, as soon as it exists.';
  return ['Attachments (read these first):', ...lines].join('\n');
}

function doneWhenBlock(todo: TodoRecord): string {
  if (todo.doneWhen.length === 0) return 'Done when: not set. Add checks with runpane todos update ' + todo.ref + ' --done-when "…".';
  return ['Done when:', ...todo.doneWhen.map(item => `- [${item.met ? 'x' : ' '}] ${item.text}`)].join('\n');
}

/** The first message a to-do's new orchestrator gets. `handedOver`: a reminder you handed to an agent (round 9). */
export function orchestratorStartText(todo: TodoRecord, groups: readonly TodoAttachmentGroup[], subTodos: readonly TodoRecord[], repo: string | null, handedOver?: HandOver): string {
  return [
    `[From Pane, To-dos] You are the orchestrator for ${todo.ref} "${todo.title}", requested by ${todo.requester.kind === 'person' ? 'the person' : todo.requester.name}.`,
    repo ? `Repo: ${repo}. Start worker Panes there with runpane panes create --repo "${repo}".` : '',
    todo.summary ? `Summary:\n${todo.summary}` : '',
    handedOver ? handOverBlock(handedOver) : '',
    doneWhenBlock(todo),
    subTodos.length > 0 ? ['Sub-to-dos:', ...subTodos.map(sub => `- ${sub.ref} ${sub.title}`)].join('\n') : '',
    attachmentsBlock(groups),
    `Keep an agent working on ${todo.ref} until it is ready for review. Split it into sub-to-dos (runpane todos create --parent ${todo.ref} "…") and assign workers (runpane todos assign <T-n> --panel <tab>). Attach what you make or use (runpane todos attach ${todo.ref} <file|url>). Ask ${todo.requester.kind === 'person' ? 'the person with runpane todos ask' : 'your requester first with runpane todos ask'} ${todo.ref} "…". Post short summaries to the to-do’s chat with runpane todos comment ${todo.ref} "…": the person reads that chat, not this tab. When every done-when check is met, run runpane todos review ${todo.ref}. If an agent start fails with machine_busy, wait: Pane tells you when capacity is back. To check something later (after a deploy, or waiting on a reply), run runpane todos snooze ${todo.ref} --until … --note … instead of waiting in a turn: Pane wakes you then with the note. Full detail: runpane todos show ${todo.ref}.`,
  ].filter(Boolean).join('\n\n');
}

/** After Pane restarted a to-do's orchestrator (launch, wake, or the supervisor). */
export function restartText(todos: ReadonlyArray<{ todo: TodoRecord; groups: readonly TodoAttachmentGroup[] }>, why: 'launch' | 'supervisor' | 'load'): string {
  const lead = why === 'launch' ? 'Pane restarted.' : why === 'load' ? 'Load came down, so Pane resumed you.' : 'Pane restarted you because nothing moved.';
  const body = todos.map(({ todo, groups }) => `${todo.ref} "${todo.title}" (${todo.state === 'accepted' ? 'accepted: finish the wrap-up, then runpane todos done ' + todo.ref : 'in progress'})\n${attachmentsBlock(groups)}`).join('\n\n');
  return `[From Pane, To-dos] ${lead} Still yours:\n\n${body}\n\nCarry them on; ask for review with runpane todos review <T-n> when ready.`;
}

export function personMessageText(todo: TodoRecord, body: string): string {
  return `[From the person, via To-dos ${todo.ref}] ${body}`;
}

/** The person's chat message, with where to answer: an agent's reply typed only in its own tab never reaches the to-do's chat. */
export function personChatText(todo: TodoRecord, body: string): string {
  return `${personMessageText(todo, body)}\n\nReply in the to-do’s chat with runpane todos comment ${todo.ref} "…": the person reads that chat, not this tab.`;
}

export function requesterReplyText(todo: TodoRecord, from: string, body: string): string {
  return `[From ${from}, via To-dos ${todo.ref}] ${body}`;
}

export function requesterQuestionText(todo: TodoRecord, question: string): string {
  return `[From To-dos ${todo.ref}, asked by its orchestrator] ${question}\nReply with runpane todos comment ${todo.ref} "…". If you can't settle it, run runpane todos comment ${todo.ref} --escalate "why" and Pane asks the person.`;
}

export type RequesterUpdate = 'review' | 'done' | 'dropped' | 'stuck';

export function requesterUpdateText(todo: TodoRecord, update: RequesterUpdate): string {
  const what = { review: 'asks the person for review', done: 'is done', dropped: 'was dropped', stuck: 'is stuck; the person has a card about it' }[update];
  return `[From Pane, To-dos] ${todo.ref} "${todo.title}", which you requested, ${what}.`;
}

export function stopText(todo: TodoRecord): string {
  return personMessageText(todo, `Stop ${todo.ref}: finish your current step, tell its workers to stop after theirs, then wait. Pane tells you when to resume.`);
}

export function resumeText(todo: TodoRecord, handedOver?: HandOver): string {
  const text = personMessageText(todo, `Resume ${todo.ref}: carry it on until it is ready for review.`);
  return handedOver ? `${text}\n\n${handOverBlock(handedOver)}` : text;
}

// ── Snoozing (round 9, T-17) ──────────────────────────────────────────────

/** A reminder you handed to an agent: its note, your words on the card, and what you wrote while it was snoozed. */
export interface HandOver {
  note: string;
  said?: string;
  held?: readonly string[];
}

function heldBlock(held: readonly string[]): string {
  return held.length > 0 ? ['While it was snoozed, the person wrote:', ...held.map(body => `- ${body}`)].join('\n') : '';
}

function handOverBlock(handedOver: HandOver): string {
  return [
    `The person handed you this reminder${handedOver.note ? `: ${handedOver.note}` : '.'}`,
    handedOver.said ? `They added: ${handedOver.said}` : '',
    heldBlock(handedOver.held ?? []),
  ].filter(Boolean).join('\n');
}

/**
 * Typed when a to-do is snoozed while its agents work: to the orchestrator (it tells its workers),
 * or, when the orchestrator snoozed it, to each worker. `when` is the wake time as the host reads it.
 */
export function snoozeText(todo: TodoRecord, when: string, note: string, to: 'orchestrator' | 'worker'): string {
  const wakesWith = note ? ` with: ${note}` : '.';
  if (to === 'worker') return `[From Pane, To-dos] ${todo.ref} is snoozed until ${when}: finish your current step, then wait. Pane wakes the orchestrator then${wakesWith}`;
  return `[From Pane, To-dos] Snoozed ${todo.ref} until ${when}: finish your current step, tell its workers to stop after theirs, then wait. Pane wakes you then${wakesWith}`;
}

export interface WakeLine {
  /** "Wed 9:00 AM": the snooze's time. */
  until: string;
  /** "overdue by 14h: Pane was closed", or "woken early by you". */
  late?: string;
}

/** The wake message: the note, any comments held while it was snoozed, then the usual attachments block. */
export function wakeText(todo: TodoRecord, line: WakeLine, note: string, held: readonly string[], groups: readonly TodoAttachmentGroup[]): string {
  return [
    `[From Pane, To-dos] Reminder for ${todo.ref} "${todo.title}" (snoozed until ${line.until}${line.late ? `, ${line.late}` : ''}): ${note || 'its time came, so carry it on.'}`,
    heldBlock(held),
    attachmentsBlock(groups),
    `Carry it on until it is ready for review (runpane todos review ${todo.ref}). To wait again, run runpane todos snooze ${todo.ref} --until … --note ….`,
  ].filter(Boolean).join('\n\n');
}

export function acceptedText(todo: TodoRecord): string {
  return personMessageText(todo, `Accepted. Do the post-acceptance work (merge only if the person asked for that, clean up, archive your Panes), then run runpane todos done ${todo.ref}.`);
}

export function changesText(todo: TodoRecord, note: string): string {
  return personMessageText(todo, `Changes asked for${note ? `: ${note}` : '.'} ${todo.ref} is back in progress.`);
}

export function subTodoAddedText(parent: TodoRecord, sub: TodoRecord, groups: readonly TodoAttachmentGroup[]): string {
  return `${personMessageText(parent, `Added sub-to-do ${sub.ref} "${sub.title}". Assign a worker to it with runpane todos assign ${sub.ref} --panel <tab>.`)}\n${attachmentsBlock(groups)}`;
}

export function assignedText(sub: TodoRecord, parent: TodoRecord | undefined, groups: readonly TodoAttachmentGroup[]): string {
  return [
    `[From Pane, To-dos] You are assigned ${sub.ref} "${sub.title}"${parent ? ` (part of ${parent.ref} "${parent.title}")` : ''}.`,
    sub.summary,
    doneWhenBlock(sub),
    attachmentsBlock(groups),
    `Reply with runpane todos comment ${sub.ref} "…" (short summaries), attach what you make (runpane todos attach ${sub.ref} <file|url>), and run runpane todos done ${sub.ref} when its done-when checks are met.`,
  ].filter(Boolean).join('\n\n');
}

export function shedText(todo: TodoRecord): string {
  return `[From Pane, To-dos] Pausing ${todo.ref} for machine load: finish your current step, commit, and stop. Pane resumes you when load comes down.`;
}

export function capacityBackText(machine: string): string {
  return `[From Pane, To-dos] Capacity is back on ${machine}; you can start agents again.`;
}
