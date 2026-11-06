import { describe, expect, it } from 'vitest';
import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import { decodeChatTabView } from '../../../../shared/types/chatTabDecoders';
import { arrangeComposerControls, isRiskyMode, modelSummary, onOffValues, phoneSettingsOrder, triggerLabels } from '../../../../shared/chatComposerControls';

function select(id: string, name: string, currentValue: string, category?: string): AgentChatConfigOption {
  const control: AgentChatConfigOption = { id, name, currentValue, options: [{ value: currentValue, name: currentValue === 'off' ? 'Off' : `${name} ${currentValue}` }] };
  if (category) control.category = category;
  return control;
}

describe('the composer row', () => {
  it('puts the mode on the left, model and effort on the right, and every other setting in the model menu', () => {
    // The six settings Claude Code's adapter sends, in its order.
    const claude = [
      select('mode', 'Mode', 'bypassPermissions', 'mode'),
      select('model', 'Model', 'opus', 'model'),
      select('effort', 'Effort', 'medium', 'thought_level'),
      select('fast_mode', 'Fast mode', 'off', 'model_config'),
      select('ultracode', 'Ultracode', 'off', 'model_config'),
      select('agent', 'Agent', 'default'),
    ];
    const row = arrangeComposerControls(claude);
    expect(row.mode?.name).toBe('Mode');
    expect(modelSummary(row)).toBe('Model opus · Effort medium');
    expect(row.more.map(control => control.name)).toEqual(['Fast mode', 'Ultracode', 'Agent']);
  });

  it('places an adapter\'s settings by id when it sends no categories', () => {
    const row = arrangeComposerControls([select('model', 'Model', 'fast'), select('mode', 'Mode', 'plan')]);
    expect(row.mode?.currentValue).toBe('plan');
    expect(row.model?.currentValue).toBe('fast');
    expect(row.more).toEqual([]);
  });

  it('trusts a category over the id, and reads "Options" when no model is named', () => {
    const row = arrangeComposerControls([select('mode', 'Output style', 'concise', 'style')]);
    expect(row.mode).toBeUndefined();
    expect(row.more.map(control => control.name)).toEqual(['Output style']);
    expect(modelSummary(row)).toBe('Options');
  });

  it('lists the phone\'s settings as Model, Effort, the others, then Permissions; marks a mode that never asks', () => {
    const row = arrangeComposerControls([
      select('mode', 'Mode', 'bypassPermissions', 'mode'), select('model', 'Model', 'opus', 'model'),
      select('effort', 'Effort', 'medium', 'thought_level'), select('agent', 'Agent', 'default'),
    ]);
    expect(phoneSettingsOrder(row).map(entry => entry.title)).toEqual(['Model', 'Effort', 'Agent', 'Permissions']);
    expect(isRiskyMode(row.mode)).toBe(true);
    // Codex's Full access mode, as codex-acp 2.5.0 names it (F-17).
    expect(isRiskyMode(arrangeComposerControls([select('mode', 'Mode', 'agent-full-access', 'mode')]).mode)).toBe(true);
    expect(isRiskyMode(arrangeComposerControls([select('mode', 'Mode', 'plan', 'mode')]).mode)).toBe(false);
  });

  it('treats a setting offering exactly On and Off as a switch', () => {
    const fast: AgentChatConfigOption = { id: 'fast_mode', name: 'Fast mode', currentValue: 'off', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] };
    expect(onOffValues(fast)).toEqual({ on: 'on', off: 'off' });
    expect(onOffValues({ ...fast, options: [{ value: 'a', name: 'Default' }, { value: 'b', name: 'explorer' }] })).toBeUndefined();
  });

  it('keeps the model button short: no "(recommended)", and no effort that is Default or repeats the model', () => {
    const named = (id: string, category: string, name: string): AgentChatConfigOption => ({ id, name: id, category, currentValue: 'v', options: [{ value: 'v', name }] });
    expect(modelSummary(arrangeComposerControls([named('model', 'model', 'Default (recommended)'), named('effort', 'thought_level', 'Default')]))).toBe('Default');
    expect(triggerLabels(arrangeComposerControls([named('model', 'model', 'Opus 5.5'), named('effort', 'thought_level', 'Medium')]))).toEqual({ model: 'Opus 5.5', effort: 'Medium' });
    expect(triggerLabels(arrangeComposerControls([named('model', 'model', 'Sonnet 5.5'), named('effort', 'thought_level', 'High (default)')]))).toEqual({ model: 'Sonnet 5.5', effort: 'High' });
  });

  it('keeps a setting\'s category through the view the PWA and phone decode (F-19)', () => {
    const view = decodeChatTabView({
      panelId: 'p', agent: 'claude', generation: 1, status: 'idle', canAttachImages: false, commands: [], permissions: [], questions: [], queue: [], messageCount: 0,
      controls: [select('permissions_v2', 'Approval', 'plan', 'mode'), select('llm', 'Engine', 'fast', 'model'), select('verbosity', 'Verbosity', 'low')],
    });
    const row = arrangeComposerControls(view.controls);
    expect(row.mode?.id).toBe('permissions_v2');
    expect(row.model?.id).toBe('llm');
    expect(row.more.map(control => control.id)).toEqual(['verbosity']);
  });
});
