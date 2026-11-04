import type { AgentChatPermission } from '../../../../shared/types/agentChat';
import type { ChatTabAnswer, ChatTabQuestion, ChatTabView } from '../../../../shared/types/chatTab';
import type { NotifyQuestion, NotifyResult, NotifySource } from '../../../../shared/types/notify';
import { permissionSummary, rejectOption } from '../../../../shared/chatTabPermissions';
import { questionFields } from '../../../../shared/chatTabQuestions';
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

interface Asked { abort: AbortController }

/**
 * Asks a chat tab's approvals and questions in Notify and on the phone too (#1215's queue).
 * The chat tab keeps its own card; whichever answer comes first wins, and the other
 * closes. A question Notify cannot show as choices stays in the chat tab only.
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
        if (!questionChoices(question)) continue;
        open.add(id);
        if (!this.asked.has(id)) this.askQuestion(id, view, question);
      }
    }
    // Answered in the chat, withdrawn by a cancel, or the tab stopped: close the card.
    for (const [id, entry] of this.asked) {
      if (!id.startsWith(`chat:${view.panelId}:`) || open.has(id)) continue;
      this.asked.delete(id);
      this.options.queue.settle(id, ANSWERED_IN_CHAT);
      entry.abort.abort();
    }
  }

  forget(panelId: string): void {
    for (const [id, entry] of this.asked) if (id.startsWith(`chat:${panelId}:`)) { this.asked.delete(id); this.options.queue.settle(id, 'The chat tab closed'); entry.abort.abort(); }
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
    if (detail) { question.detail = detail; question.detailLabel = summary.kind === 'plan' ? 'Show the plan' : summary.kind === 'command' ? 'Show the command' : 'Show details'; }
    if (yes && no) question.agentPrompt = { yes, no };
    this.ask(id, question, source, answer => {
      const option = permission.options.find(entry => entry.name === answer);
      if (option) this.options.answerPermission(view.panelId, permission.id, option.optionId);
    });
  }

  private askQuestion(id: string, view: ChatTabView, question: ChatTabQuestion): void {
    const source = this.options.source(view.panelId);
    const choices = questionChoices(question);
    if (!source || !choices) return;
    this.ask(id, { ui: 'options', title: question.message, choices: choices.choices.slice(0, 9).map(choice => ({ label: choice.title, detail: choice.description })) }, source, answer => {
      const choice = choices.choices.find(entry => entry.title === answer);
      if (choice) this.options.answerQuestion(view.panelId, question.id, { action: 'accept', content: { [choices.key]: choice.value } });
    });
  }

  private ask(id: string, question: NotifyQuestion, source: NotifySource, apply: (answer: string) => void): void {
    const abort = new AbortController();
    this.asked.set(id, { abort });
    void this.options.queue.ask({ id, question, source }, abort.signal).then(result => {
      if (abort.signal.aborted || !this.asked.has(id)) return;
      this.asked.delete(id);
      if ('answer' in result) {
        try { apply(result.answer); }
        // Answered in the chat a moment earlier: the chat's answer stands.
        catch (error) { console.warn(`[ChatTabs] A Notify answer for ${id} was not applied: ${reasonOf(error)}`); }
      }
    }, () => { this.asked.delete(id); });
  }
}

/** A question Notify can ask as choices: one single-choice field (a free-text companion is optional). */
function questionChoices(question: ChatTabQuestion): { key: string; choices: Array<{ value: string; title: string; description?: string }> } | undefined {
  const fields = questionFields(question.schema);
  const choice = fields.filter(field => field.kind === 'single');
  const others = fields.filter(field => field.kind !== 'single' && field.kind !== 'text');
  if (choice.length !== 1 || others.length) return undefined;
  const [field] = choice;
  return field.kind === 'single' ? { key: field.key, choices: field.choices } : undefined;
}
