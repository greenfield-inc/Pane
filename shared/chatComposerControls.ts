import type { AgentChatConfigOption } from './types/agentChat';

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

/** What the model menu's button reads: "Opus 5.5 · Medium", or "Options" when the agent names no model. */
export function modelSummary({ model, effort }: ComposerControls): string {
  return [model, effort].flatMap(control => control ? [choiceName(control)] : []).join(' · ') || 'Options';
}

/** Permission modes that let the agent act without asking: the phone marks them on the composer row. */
const RISKY_MODES = new Set(['bypassPermissions', 'dontAsk', 'full-access']);

export function isRiskyMode(mode: AgentChatConfigOption | undefined): boolean {
  return !!mode && RISKY_MODES.has(mode.currentValue);
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
