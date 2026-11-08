import type { AgentChatPermission } from '../../../../shared/types/agentChat';
import type { ChatTabAnswer, ChatTabQuestion, ChatTabView } from '../../../../shared/types/chatTab';
import type { NotifyQuestion, NotifyResult, NotifySource } from '../../../../shared/types/notify';
import { permissionSummary, rejectOption } from '../../../../shared/chatTabPermissions';
import { questionFields, unshownRequiredFields, type QuestionChoice, type QuestionField } from '../../../../shared/chatTabQuestions';
import type { JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { reasonOf } from '../../../../shared/paneError';

/** What the bridge needs from Notify (NotifyQueue), as #1215's Claude prompt bridge uses it. */
export interface ChatPromptQueue {
  ask(request: { id: string; question: NotifyQuestion; source: NotifySource }, signal: AbortSignal): Promise<NotifyResult>;
  settle(id: string, summary: string): void;
}

export interface ChatTabNotifyOptions {
  queue: ChatPromptQueue;
  /** Who asked, as Notify names it; undefined when the tab or its Pane is gone. */
  source(panelId: string): NotifySource | undefined;
  /** Settings → AI agents → Answer prompts from Pane. */
  enabled(): boolean;
  answerPermission(panelId: string, requestId: string, optionId: string): void;
  answerQuestion(panelId: string, questionId: string, answer: ChatTabAnswer): void;
}

const ANSWERED_IN_CHAT = 'Answered in the chat';
const MAX_DETAIL = 32_000;
/** Notify's last choice (or chip) on a question: declines it, as the chat card's Skip does. */
const SKIP = 'Skip question';
/** Notify shows 1 to 9 choices; one is Skip. A longer list is asked as free text with chips. */
const MAX_CHOICES = 8;

/** One open Notify item; a form's series reuses its key while it moves from field to field. */
interface Asked { abort: AbortController; queueId: string }

/** One Notify item of a form: a field, and the free-text field a typed answer fills, if any. */
interface Step { field: QuestionField; companion?: string }

/**
 * Asks a chat tab's approvals and questions in Notify and on the phone too (#1215's queue).
 * The chat tab keeps its own card; whichever answer comes first wins, and the other
 * closes. A question form is asked one field at a time and answered once, with every field.
 */
export class ChatTabNotifyBridge {
  private readonly asked = new Map<string, Asked>();

  constructor(private readonly options: ChatTabNotifyOptions) {}

  /** Call with every view the host publishes. */
  observe(view: ChatTabView): void {
    const open = new Set<string>();
    if (this.options.enabled()) {
      for (const permission of view.permissions) {
        const id = `chat:${view.panelId}:${permission.id}`;
        open.add(id);
        if (!this.asked.has(id)) this.askPermission(id, view, permission);
      }
      for (const question of view.questions) {
        const id = `chat:${view.panelId}:${question.id}`;
        const steps = questionSteps(question);
        // Only the chat can say why a form with a field Pane can't show is skip-only.
        if (!steps.length || unshownRequiredFields(question.schema).length) continue;
        open.add(id);
        if (!this.asked.has(id)) this.askQuestion(id, view, question, steps);
      }
    }
    // Answered in the chat, withdrawn by a cancel, or the tab stopped: close the card.
    for (const [id, entry] of this.asked) {
      if (!id.startsWith(`chat:${view.panelId}:`) || open.has(id)) continue;
      this.asked.delete(id);
      this.options.queue.settle(entry.queueId, ANSWERED_IN_CHAT);
      entry.abort.abort();
    }
  }

  forget(panelId: string): void {
    for (const [id, entry] of this.asked) if (id.startsWith(`chat:${panelId}:`)) { this.asked.delete(id); this.options.queue.settle(entry.queueId, 'The chat tab closed'); entry.abort.abort(); }
  }

  private askPermission(id: string, view: ChatTabView, permission: AgentChatPermission): void {
    const source = this.options.source(view.panelId);
    if (!source) return;
    const agent = view.agent === 'claude' ? 'Claude' : 'Codex';
    const summary = permissionSummary(permission, agent);
    const detail = summary.plan ?? summary.detail;
    if (detail && detail.length > MAX_DETAIL) return;
    const yes = permission.options.find(option => option.kind.startsWith('allow'))?.name ?? permission.options[0]?.name;
    const reject = rejectOption(permission);
    const no = permission.options.find(option => option.optionId === reject)?.name ?? permission.options.at(-1)?.name;
    const question: NotifyQuestion = {
      ui: 'options', title: summary.heading,
      choices: permission.options.slice(0, 9).map(option => ({ label: option.name, recommended: option.name === yes || undefined })),
    };
    // An options card shows its context, as for a terminal agent's prompt; `detail` is for approve cards only.
    if (detail) question.context = detail;
    if (yes && no) question.agentPrompt = { yes, no };
    this.ask(id, id, question, source, answer => {
      const option = permission.options.find(entry => entry.name === answer);
      if (option) this.options.answerPermission(view.panelId, permission.id, option.optionId);
    });
  }

  private askQuestion(id: string, view: ChatTabView, question: ChatTabQuestion, steps: Step[]): void {
    const source = this.options.source(view.panelId);
    if (source) this.askStep(id, { view, question, steps, source }, 0, {}, 0);
  }

  /** Asks field `index` of a form; the last answer sends the whole form to the agent. */
  private askStep(id: string, form: { view: ChatTabView; question: ChatTabQuestion; steps: Step[]; source: NotifySource }, index: number, content: Record<string, JsonValue>, attempt: number, retry?: string): void {
    const { view, question, steps, source } = form;
    const step = steps[index];
    const queueId = index === 0 && attempt === 0 ? id : `${id}#${index + 1}.${attempt}`;
    const prompt = stepQuestion(question.message, step, index, steps.length);
    // The paused turn resumes with the person's typed words: a reply is the answer (J12).
    prompt.replyIsAnswer = true;
    if (retry) prompt.context = [retry, prompt.context].filter(Boolean).join('\n');
    this.ask(id, queueId, prompt, source, answer => {
      if (spoken(answer) === spoken(SKIP)) { this.options.answerQuestion(view.panelId, question.id, { action: 'decline' }); return; }
      const value = fieldValue(step, answer);
      if (!value) { this.askStep(id, form, index, content, attempt + 1, `"${answer}" doesn't fit: ${step.field.kind === 'number' ? 'answer with a number' : 'name one of the choices'}.`); return; }
      const next = { ...content, ...value };
      if (index + 1 < steps.length) this.askStep(id, form, index + 1, next, 0);
      else this.options.answerQuestion(view.panelId, question.id, { action: 'accept', content: next });
    });
  }

  private ask(id: string, queueId: string, question: NotifyQuestion, source: NotifySource, apply: (answer: string) => void): void {
    const entry: Asked = { abort: new AbortController(), queueId };
    this.asked.set(id, entry);
    void this.options.queue.ask({ id: queueId, question, source }, entry.abort.signal).then(result => {
      if (entry.abort.signal.aborted || this.asked.get(id) !== entry) return;
      this.asked.delete(id);
      if ('answer' in result) {
        try { apply(result.answer); }
        // Answered in the chat a moment earlier: the chat's answer stands.
        catch (error) { console.warn(`[ChatTabs] A Notify answer for ${id} was not applied: ${reasonOf(error)}`); }
      }
    }, () => { if (this.asked.get(id) === entry) this.asked.delete(id); });
  }
}

/**
 * The Notify items a question form takes, in order. A free-text field right after a choice
 * field and named after it (AskUserQuestion's `question_0_custom`) is that field's typed answer.
 */
function questionSteps(question: ChatTabQuestion): Step[] {
  const steps: Step[] = [];
  for (const field of questionFields(question.schema)) {
    const last = steps.at(-1);
    if (field.kind === 'text' && last && !last.companion && (last.field.kind === 'single' || last.field.kind === 'multiple') && field.key.startsWith(`${last.field.key}_`)) last.companion = field.key;
    else steps.push({ field });
  }
  return steps;
}

/**
 * Single choice and yes/no are options; multiple choice, text and numbers are free text
 * (Notify has no multi-select, so a multiple-choice answer names its choices, comma-separated).
 */
function stepQuestion(message: string, { field }: Step, index: number, total: number): NotifyQuestion {
  const label = field.title !== field.key && field.title !== message ? field.title : undefined;
  const title = total > 1 ? `${message} (${index + 1} of ${total})${label ? `: ${label}` : ''}` : message;
  const context = [total > 1 ? undefined : label, field.description];
  const choices = field.kind === 'boolean' ? [{ value: 'yes', title: 'Yes' }, { value: 'no', title: 'No' }] : field.kind === 'single' ? field.choices : undefined;
  let question: NotifyQuestion;
  if (choices && choices.length <= MAX_CHOICES) {
    question = { ui: 'options', title, choices: [...choices.map(choice => choice.description ? { label: choice.title, detail: choice.description } : { label: choice.title }), { label: SKIP }] };
  } else {
    const named = field.kind === 'single' || field.kind === 'multiple' ? field.choices : [];
    if (field.kind === 'multiple') context.push('Name one or more, separated by commas.');
    question = { ui: 'ask', title, suggestions: [...named.map(choice => choice.title), SKIP] };
  }
  const text = context.filter(Boolean).join('\n');
  if (text) question.context = text;
  return question;
}

/** The form content one answer gives, or undefined when it fits neither the field nor its free-text companion. */
function fieldValue({ field, companion }: Step, answer: string): Record<string, JsonValue> | undefined {
  const text = answer.trim();
  if (!text) return undefined;
  if (field.kind === 'text') return { [field.key]: text };
  if (field.kind === 'number') return Number.isFinite(Number(text)) ? { [field.key]: Number(text) } : undefined;
  if (field.kind === 'boolean') return spoken(text) === 'yes' ? { [field.key]: true } : spoken(text) === 'no' ? { [field.key]: false } : undefined;
  if (field.kind === 'single') {
    const choice = findChoice(field.choices, text);
    if (choice) return { [field.key]: choice.value };
    return companion ? { [companion]: text } : undefined;
  }
  if (field.kind !== 'multiple') return undefined;
  const { choices } = field;
  const parts = text.split(/[,;\n]/).map(part => part.trim()).filter(Boolean);
  const picked = parts.map(part => findChoice(choices, part));
  const values = picked.flatMap(choice => choice ? [choice.value] : []);
  const rest = parts.filter((_, at) => !picked[at]);
  if (rest.length && !companion) return undefined;
  const content: Record<string, JsonValue> = {};
  if (values.length) content[field.key] = [...new Set(values)];
  if (rest.length && companion) content[companion] = rest.join(', ');
  return content;
}

function findChoice(choices: QuestionChoice[], text: string): QuestionChoice | undefined {
  const said = spoken(text);
  return choices.find(choice => spoken(choice.title) === said) ?? choices.find(choice => spoken(choice.value) === said);
}

/** Typed or dictated: "Unit tests." names "Unit tests". */
function spoken(text: string): string {
  return text.trim().replace(/[.!?]+$/, '').toLowerCase();
}
