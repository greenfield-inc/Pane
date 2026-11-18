import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { chatTurns } from '../../../../shared/chatTabPresentation';
import type { AgentChatMessage } from '../../../../shared/types/agentChat';
import type { DevicePanelPhase } from '../../../../shared/types/devices';
import { ChatTurnView, type ChatTurnActions } from './ChatTurns';

/** device_open's result as Claude's adapter carries an MCP tool's text: the JSON runpane printed. */
const openResult = JSON.stringify({
  ok: true,
  device: { id: 'SIM', platform: 'ios', name: 'iPhone 17 Pro', os: 'iOS 27.0', machine: 'This Mac', state: 'booted', paneMade: true },
  panelId: 'device-tab',
  paneDevice: { kind: 'pane-device', panelId: 'device-tab', name: 'iPhone 17 Pro', os: 'iOS 27.0', machine: 'This Mac' },
});

const messages: AgentChatMessage[] = [
  { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Check the checkout screen on iPhone' }] },
  { id: 'a', role: 'assistant', parts: [
    { type: 'tool', id: 't1', title: 'mcp__pane__device_open', status: 'completed', kind: 'other', content: [{ type: 'content', content: { type: 'text', text: openResult } }] },
    { type: 'text', text: 'The Pay button sits 4 px from the edge.' },
  ] },
];

function render(phase: DevicePanelPhase | undefined, withDevices = true): string {
  const [turn] = chatTurns(messages, { running: true });
  const actions: ChatTurnActions = withDevices ? { device: { openedHere: [], phase: () => phase, frame: async () => undefined, open: () => undefined } } : {};
  return renderToStaticMarkup(<ChatTurnView turn={turn} waiting={new Set()} actions={actions} latest />).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('device card in a chat', () => {
  it('names the device at its device_open step, with Live while the device runs', () => {
    const text = render('live');
    expect(text).toContain('Opened iPhone 17 Pro · iOS 27.0 · This Mac');
    expect(text).toContain('Live');
  });

  it('folds into the turn\'s steps once the device closes', () => {
    expect(render('closed')).not.toContain('Opened iPhone 17 Pro');
  });

  it('stays a plain step row in a client without device cards', () => {
    expect(render('live', false)).not.toContain('Opened iPhone 17 Pro');
  });
});
