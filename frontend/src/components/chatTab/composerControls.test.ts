import { describe, expect, it } from 'vitest';
import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import { arrangeComposerControls, modelSummary } from './composerControls';

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
});
