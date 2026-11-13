import type { AgentChatConfigOption } from './types/agentChat';
import { CHAT_FULL_ACCESS_CONTROL } from './types/chatTab';
import { RISKY_AGENT_MODES } from './agents';

/**
 * The agent's settings, sorted into the composer's one row: the permission mode
 * on the left, model and effort together on the right, and everything else in
 * the model menu. ACP names each setting's category; an adapter that leaves it
 * out is placed by the usual ids.
 */
export interface ComposerControls {
  mode?: AgentChatConfigOption;
  model?: AgentChatConfigOption;
  effort?: AgentChatConfigOption;
  /** Settings shown only inside the model menu, each under its own name. */
  more: AgentChatConfigOption[];
}

/** Where a setting goes: by its ACP category, or by these ids when the adapter sends no category. */
interface RoleRule { role: 'mode' | 'model' | 'effort'; category: string; ids: readonly string[] }

const ROLES: readonly RoleRule[] = [
  { role: 'mode', category: 'mode', ids: ['mode'] },
  { role: 'model', category: 'model', ids: ['model'] },
  { role: 'effort', category: 'thought_level', ids: ['effort', 'reasoning_effort', 'thought_level'] },
];

export function arrangeComposerControls(controls: readonly AgentChatConfigOption[]): ComposerControls {
  const arranged: ComposerControls = { more: [] };
  for (const control of controls) {
    const match = ROLES.find(({ role, category, ids }) => !arranged[role]
      && (control.category ? control.category === category : ids.includes(control.id)));
    if (match) arranged[match.role] = control;
    else arranged.more.push(control);
  }
  return arranged;
}

/** The name of a setting's current choice, as the adapter labels it. */
export function choiceName(control: AgentChatConfigOption): string {
  return control.options.find(option => option.value === control.currentValue)?.name ?? control.currentValue;
}

/** A choice's name without a trailing "(recommended)" or "(default)": the menu keeps the full name. */
function shortName(name: string): string {
  return name.replace(/\s*\((recommended|default)\)\s*$/i, '');
}

/**
 * What the model button shows (D-120): the model, then its effort, short. An effort of
 * "Default", or one that only repeats the model, is left out.
 */
export interface TriggerLabels { model?: string; effort?: string }

export function triggerLabels({ model, effort }: ComposerControls): TriggerLabels {
  const modelLabel = model ? shortName(choiceName(model)) : undefined;
  const effortLabel = effort ? shortName(choiceName(effort)) : undefined;
  const repeats = !effortLabel || /^default$/i.test(effortLabel) || effortLabel === modelLabel;
  return { model: modelLabel, effort: repeats ? undefined : effortLabel };
}

/** What the model menu's button reads: "Opus 5.5 · Medium", or "Options" when the agent names no model. */
export function modelSummary(controls: ComposerControls): string {
  const { model, effort } = triggerLabels(controls);
  return [model, effort].filter(Boolean).join(' · ') || 'Options';
}

/** A permission mode that lets the agent act without asking (each agent's `riskyModes` in the agents config). */
export function isRiskyMode(mode: AgentChatConfigOption | undefined): boolean {
  return !!mode && RISKY_AGENT_MODES.has(mode.currentValue);
}

/**
 * Pane's own Full access setting (CHAT_FULL_ACCESS_CONTROL), when it is on: the agent acts
 * without asking because Pane answers each approval. Viewers mark it like a risky mode.
 */
export function paneFullAccessOn(controls: readonly AgentChatConfigOption[]): AgentChatConfigOption | undefined {
  const control = controls.find(entry => entry.id === CHAT_FULL_ACCESS_CONTROL);
  return control && onOffValues(control)?.on === control.currentValue ? control : undefined;
}

/** A setting whose only choices are On and Off (Claude's Fast mode, Ultracode): the phone shows it as a switch. */
export function onOffValues(control: AgentChatConfigOption): { on: string; off: string } | undefined {
  if (control.options.length !== 2) return undefined;
  const on = control.options.find(option => option.name.toLowerCase() === 'on');
  const off = control.options.find(option => option.name.toLowerCase() === 'off');
  return on && off ? { on: on.value, off: off.value } : undefined;
}

/** The phone's settings list, top to bottom: Model, Effort, the agent's other settings, then Permissions. */
export function phoneSettingsOrder({ mode, model, effort, more }: ComposerControls): Array<{ control: AgentChatConfigOption; title: string }> {
  return [
    ...[model, effort, ...more].flatMap(control => control ? [{ control, title: control.name }] : []),
    ...(mode ? [{ control: mode, title: 'Permissions' }] : []),
  ];
}
