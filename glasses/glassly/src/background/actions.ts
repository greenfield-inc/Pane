// Pane's Actions for Glassly's AI assistant: what needs you, a PR's status, answer a card, start a
// Session. Glassly lets any installed miniapp call a public action and gives actions no
// confirmation step, so Pane answers only Glassly's assistant (by the caller name Glassly stamps),
// reads only what the glasses already show, and turns every change into a request you confirm with
// one press on the glasses. An unconfirmed request lapses after 2 minutes.
import type { ConfirmRequest } from '../../../src/app';
import type { Card, PaneSource } from '../../../src/model';

/** Glassly's own assistant; no other miniapp may use Pane's Actions. */
const ASSISTANT_PACKAGES: ReadonlySet<string> = new Set(['com.glassly.assistant', 'com.glassly.ai']);
/** How long a request waits for its press on the glasses. */
export const STAGED_MS = 2 * 60_000;

/** A change an Action asked for, waiting for one press on the glasses. */
export interface Staged {
  /** What opening Pane shows: a card with a choice selected, or a request to confirm. */
  show: { kind: 'card'; key: string; choice: number } | { kind: 'confirm'; request: ConfirmRequest };
  /** What the confirming notification says. */
  title: string;
  expiresAt: number;
}

/** The parameters Pane's Actions take, decoded at the boundary (index.ts). */
export interface ActionParams {
  pane?: string;
  answer?: string;
  goal?: string;
  computer?: string;
}

export type ActionResult =
  | { ok: true; waiting: Array<{ computer: string; pane: string; question: string; choices: string[] }> }
  | { ok: true; prs: Array<{ computer: string; pane: string; pr: number; state: string; title?: string }> }
  | { ok: true; message: string }
  | { ok: false; error: string };

const text = (value: string | undefined) => value?.trim() ?? '';
/** What the glasses offer to press on a card: approve's two rows, an ask's suggestions, or its choices. */
const choicesOf = (card: Card) => (card.ui === 'approve' ? ['Approve', 'Not yet'] : card.ui === 'ask' ? card.suggestions : card.choices);
const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0;
const matches = (name: string, wanted: string) => name.toLowerCase().includes(wanted.toLowerCase());

export class PaneActions {
  constructor(private readonly deps: { source(): PaneSource | null; now(): number; stage(staged: Staged): void }) {}

  handle(action: string, params: ActionParams, caller: string): ActionResult {
    if (!ASSISTANT_PACKAGES.has(caller)) return { ok: false, error: "Pane's actions answer only Glassly's assistant." };
    const source = this.deps.source();
    if (!source || source.demo) return { ok: false, error: 'Pane on these glasses is not paired with a computer yet.' };
    switch (action) {
      case 'list_waiting':
        return { ok: true, waiting: source.cards().filter((card) => card.waiting).map((card) => ({ computer: card.machine, pane: card.paneName, question: card.title, choices: choicesOf(card) })) };
      case 'pr_status': {
        const name = text(params.pane);
        const prs: Array<{ computer: string; pane: string; pr: number; state: string; title?: string }> = [];
        for (const computer of source.computers()) {
          for (const entry of computer.entries) {
            if (!entry.pr || (name && !matches(entry.name, name))) continue;
            const row: (typeof prs)[number] = { computer: computer.name, pane: entry.name, pr: entry.pr.number, state: entry.pr.state };
            if (entry.pr.title) row.title = entry.pr.title;
            prs.push(row);
          }
        }
        return { ok: true, prs };
      }
      case 'answer_card':
        return this.answer(source, text(params.pane), text(params.answer));
      case 'start_session':
        return this.startSession(source, text(params.goal), text(params.computer));
      default:
        return { ok: false, error: `Pane has no action ${action}.` };
    }
  }

  private answer(source: PaneSource, pane: string, answer: string): ActionResult {
    if (!answer) return { ok: false, error: 'Say what to answer.' };
    const waiting = source.cards().filter((card) => card.waiting && card.ui !== 'secret');
    const found: Card[] = pane ? waiting.filter((card) => matches(card.paneName, pane)) : waiting.slice(0, 1);
    const card = found[0];
    if (!card || found.length > 1) return { ok: false, error: card ? `More than one question matches ${pane}; name the Pane.` : 'No question is waiting there.' };
    const expiresAt = this.deps.now() + STAGED_MS;
    const choices = choicesOf(card);
    const choice = choices.findIndex((label) => same(label, answer));
    if (choice >= 0) {
      this.deps.stage({ show: { kind: 'card', key: card.key, choice }, title: `Confirm on the glasses: ${card.paneName} → ${choices[choice]}`, expiresAt });
    } else {
      const summary = `"${answer}"`;
      const request: ConfirmRequest = card.ui === 'approve'
        ? { kind: 'answer', key: card.key, answer: { approved: false, note: answer }, summary: `Not yet, ${summary}`, expiresAt }
        : { kind: 'answer', key: card.key, answer: { text: answer }, summary, expiresAt };
      this.deps.stage({ show: { kind: 'confirm', request }, title: `Confirm on the glasses: ${card.paneName} → ${summary}`, expiresAt });
    }
    return { ok: true, message: 'Waiting for you to confirm on the glasses: open Pane and press once.' };
  }

  private startSession(source: PaneSource, goal: string, wanted: string): ActionResult {
    if (!goal) return { ok: false, error: 'Say what the Session is for.' };
    const live = source.computers().filter((computer) => computer.status === 'live');
    const computer = wanted ? live.find((candidate) => matches(candidate.name, wanted)) : live[0];
    if (!computer) return { ok: false, error: wanted ? `${wanted} isn't reachable from the glasses.` : 'None of your computers is reachable.' };
    const expiresAt = this.deps.now() + STAGED_MS;
    this.deps.stage({
      show: { kind: 'confirm', request: { kind: 'session', computerId: computer.id, machine: computer.name, goal, expiresAt } },
      title: `Confirm on the glasses: new Session on ${computer.name}`,
      expiresAt,
    });
    return { ok: true, message: 'Waiting for you to confirm on the glasses: open Pane and press once.' };
  }
}
