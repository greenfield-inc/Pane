import { DEFAULT_AGENT_ID } from '../../../../shared/agents';
import type { NotifyResult } from '../../../../shared/types/notify';
import type { LoadSample } from './loadGate';
import type { TodoCard, TodoHost, TodoPanelInfo, TodoSessionInfo, TypeResult } from './todoService';

/** A fake Pane: Sessions, tabs that can be mid-turn, down or hold unsent text, and cards you answer. */
export class FakeHost implements TodoHost {
  sessions = new Map<string, TodoSessionInfo>();
  panels = new Map<string, TodoPanelInfo>();
  midTurn = new Set<string>();
  unsent = new Set<string>();
  down = new Set<string>();
  typed: Array<{ panelId: string; text: string }> = [];
  resumed: string[] = [];
  paused: string[][] = [];
  cards: Array<TodoCard & { answer: (result: NotifyResult) => void }> = [];
  /** Cards Pane ended itself (closeCard), with why. */
  closed: Array<{ id: string; summary: string }> = [];
  load: Omit<LoadSample, 'at'> = { cpuPercent: 5, memory: 'ok' };
  gateEnabled = true;
  archiveResult = { archived: ['clean'], kept: [{ name: 'keyboard-approvals', reason: '2 unpushed commits' }], sessionArchived: false };
  private nextSession = 1;

  machineName() { return 'This Mac'; }
  /** T-51: this machine's install id; undefined plays an older Pane that sends none. */
  installIdValue: string | undefined = 'install-a';
  installId() { return this.installIdValue; }
  /** Every to-do number a created Session was marked with, in order. */
  createdFor: number[] = [];
  async createSession(input: { name: string; openingPrompt: string; todoNumber: number }) {
    this.createdFor.push(input.todoNumber);
    const id = `s${this.nextSession++}`;
    const panelId = `${id}-orch`;
    this.sessions.set(id, { id, name: input.name, orchestratorPanelId: panelId, archived: false, paneIds: [] });
    this.panels.set(panelId, { name: 'orchestrator', sessionId: id, sessionName: input.name, orchestrator: true, agentId: DEFAULT_AGENT_ID });
    this.typed.push({ panelId, text: input.openingPrompt });
    return { sessionId: id, orchestratorPanelId: panelId, prompted: true };
  }
  session(id: string) { return this.sessions.get(id) ?? null; }
  panel(id: string) { return this.panels.get(id) ?? null; }
  projectName() { return 'Pane'; }
  isMidTurn(id: string) { return this.midTurn.has(id); }
  async hasUnsentText(id: string) { return this.unsent.has(id); }
  async isPanelDown(id: string) { return this.down.has(id); }
  async typeIntoTab(panelId: string, text: string): Promise<TypeResult> { this.typed.push({ panelId, text }); return 'delivered'; }
  async resumePanel(id: string) { this.resumed.push(id); this.down.delete(id); return true; }
  restarted: string[] = [];
  async restartPanel(id: string) { this.restarted.push(id); return true; }
  async pausePanels(ids: string[]) { this.paused.push(ids); }
  isPanelProtected() { return false; }
  usageLimitUntil() { return null; }
  ask(card: TodoCard): Promise<NotifyResult> {
    return new Promise(resolve => this.cards.push({ ...card, answer: resolve }));
  }
  closeCard(id: string, summary: string) { this.closed.push({ id, summary }); }
  async archiveSessionPanes() { return this.archiveResult; }
  async restoreSession() {}
  async sampleLoad() { return this.load; }
  loadGateEnabled() { return this.gateEnabled; }
  /** Settings › Advanced › Experimental › To-dos (T-39). */
  todosEnabled = true;
  todosOn() { return this.todosEnabled; }
  prOf() { return undefined; }
  log() {}

  /** An orchestrator tab in Session A, the requester of to-dos it creates. */
  addRequester(): string {
    this.sessions.set('sA', { id: 'sA', name: 'Billing rewrite', orchestratorPanelId: 'tA', archived: false, paneIds: [] });
    this.panels.set('tA', { name: 'orchestrator', sessionId: 'sA', sessionName: 'Billing rewrite', orchestrator: true });
    return 'tA';
  }
  typedInto(panelId: string): string[] { return this.typed.filter(entry => entry.panelId === panelId).map(entry => entry.text); }
}

