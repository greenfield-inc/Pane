import { createRoot } from 'react-dom/client';
import ChatTabPanel from '../../frontend/src/components/chatTab/ChatTabPanel';
import { DevicePanel } from '../../frontend/src/components/panels/device/DevicePanel';
import { DeviceClientContext, type DeviceTabClient } from '../../frontend/src/components/panels/device/deviceClient';
import type { ChatTurnActions } from '../../frontend/src/components/chatTab/ChatTurns';
import type { ChatTabClient, ChatTabView } from '../../shared/types/chatTab';
import type { DeviceInput, DevicePanelPhase, DevicePanelState } from '../../shared/types/devices';
import type { ToolPanel } from '../../shared/types/panels';
import '../../frontend/src/index.css';

// The device tab and the chat card (D-71 option 2) with a fake device: ?view=pane shows a chat
// beside a live device tab; ?view=states shows every tab state side by side. ?theme=dark.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? ['dark', 'dusk', 'dusk-oled'] : ['light', 'folio'];
document.documentElement.classList.add(...theme);
document.documentElement.style.colorScheme = theme[0];

/** A phone screen drawn here: a checkout page, so frames look like an app without shipping an image. */
function screen(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 402;
  canvas.height = 874;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 402, 874);
  g.fillStyle = '#111'; g.font = '600 17px -apple-system, sans-serif'; g.fillText('9:41', 40, 34);
  g.fillStyle = '#007aff'; g.font = '16px -apple-system, sans-serif'; g.fillText('‹ Cart', 20, 96);
  g.fillStyle = '#111'; g.font = 'bold 30px -apple-system, sans-serif'; g.fillText('Checkout', 20, 136);
  const row = (y: number, color: string, title: string, sub: string, price: string) => {
    g.fillStyle = color; g.fillRect(20, y, 52, 52);
    g.fillStyle = '#111'; g.font = '16px -apple-system, sans-serif'; g.fillText(title, 86, y + 22);
    g.fillStyle = '#8a8a8e'; g.font = '13px -apple-system, sans-serif'; g.fillText(sub, 86, y + 42);
    g.fillStyle = '#111'; g.font = '600 16px -apple-system, sans-serif'; g.fillText(price, 318, y + 32);
  };
  row(170, '#f2d8c9', 'Linen shirt', 'Size M · Sand', '$48.00');
  row(240, '#d3e3f5', 'Canvas tote', 'One size · Blue', '$32.00');
  g.fillStyle = '#111'; g.font = '600 18px -apple-system, sans-serif'; g.fillText('Total', 20, 350); g.fillText('$86.00', 318, 350);
  g.fillStyle = '#111'; g.beginPath(); g.roundRect(20, 780, 362, 54, 14); g.fill();
  g.fillStyle = '#fff'; g.font = '600 17px -apple-system, sans-serif'; g.fillText('Pay $86.00', 156, 813);
  return canvas.toDataURL('image/jpeg', 0.9);
}

declare global { interface Window { qaInputs: DeviceInput[]; qaPower: string[] } }
window.qaInputs = [];
window.qaPower = [];
const frame = screen();
const client: DeviceTabClient = {
  clientId: 'fixture',
  streamUrl: () => undefined,
  frame: async () => frame,
  input: async (_panel, input) => { window.qaInputs.push(input); },
  visible: async () => undefined,
  takeOver: async () => { window.qaPower.push('take-over'); },
  power: async (_panel, action) => { window.qaPower.push(action); },
};

function devicePanel(id: string, state: Partial<DevicePanelState>): ToolPanel {
  const custom: DevicePanelState = { deviceId: 'SIM', platform: 'ios', name: 'iPhone 17 Pro', os: 'iOS 27', machine: 'This Mac', phase: 'live', ...state };
  return { id, sessionId: 'pane', type: 'device', title: custom.name, state: { isActive: true, customState: custom }, metadata: { createdAt: '2026-11-15T00:00:00.000Z', lastActiveAt: '2026-11-15T00:00:00.000Z', position: 1 } };
}

const STATES: { label: string; state: Partial<DevicePanelState> }[] = [
  { label: 'Live', state: {} },
  { label: 'Installing', state: { phase: 'installing' } },
  { label: 'Booting', state: { phase: 'booting' } },
  { label: 'Off after idle', state: { phase: 'off' } },
  { label: 'In use by another Pane', state: { phase: 'in-use', heldBy: { paneId: 'other', paneName: 'onboarding-copy' } } },
  { label: 'Runs on a linked Mac', state: { machine: "Parsa's MacBook Pro", machineId: 'mbp', machineReason: { kind: 'automatic', text: "Runs on Parsa's MacBook Pro. This PC has no Xcode." } } },
  { label: 'No Mac linked', state: { phase: 'no-mac', name: 'iPhone', machine: 'This PC' } },
  { label: 'Linked Mac offline', state: { phase: 'mac-offline', name: 'iPhone', machine: 'This PC', macName: "Parsa's MacBook Pro" } },
];

const openResult = JSON.stringify({ ok: true, panelId: 'device', paneDevice: { kind: 'pane-device', panelId: 'device', name: 'iPhone 17 Pro', os: 'iOS 27', machine: 'This Mac' } });
const chatPhase: DevicePanelPhase = params.get('card') === 'closed' ? 'closed' : 'live';
const view: ChatTabView = {
  panelId: 'chat', agent: 'claude', generation: 1, status: 'idle', canAttachImages: true, commands: [], permissions: [], questions: [], queue: [], messageCount: 2, controls: [],
  transcript: { panelId: 'chat', generation: 1, revision: 0, start: 0, messages: [
    { id: 'user:1', role: 'user', parts: [{ type: 'text', text: 'Check the new checkout button on iPhone and fix the spacing' }] },
    { id: 'a1', role: 'assistant', parts: [
      { type: 'text', text: "I'll build the app, open it on a simulator and look at the checkout screen." },
      { type: 'tool', id: 't1', title: 'pnpm ios:build', kind: 'execute', status: 'completed', input: { command: 'pnpm ios:build' } },
      { type: 'tool', id: 't2', title: 'mcp__pane__device_open', kind: 'other', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: openResult } }] },
      { type: 'text', text: 'The Pay button sits 4 px from the bottom edge. Fixing the safe area inset now.' },
    ] },
  ] },
};
const chatClient: ChatTabClient = {
  get: async () => structuredClone(view), history: async () => [], send: async (_panel, request) => ({ operationId: request.operationId, state: 'accepted' }), receipt: async () => undefined,
  unqueue: async () => {}, sendNow: async () => {}, editQueued: async () => {}, clear: async () => {}, stopTask: async () => {}, cancel: async () => {}, permission: async () => {}, answer: async () => {}, restart: async () => {}, signIn: async () => ({ panelId: 'chat' }),
  configure: async () => {}, onEvent: () => () => {}, onState: () => () => {}, conversations: async () => [], resume: async () => {}, dismissBanner: async () => {},
};
const actions: ChatTurnActions = {
  device: { openedHere: [], phase: () => chatPhase, frame: async () => frame, open: panelId => { window.qaPower.push(`open:${panelId}`); } },
};

const root = createRoot(document.getElementById('root')!);
if (params.get('view') === 'states') {
  root.render(
    <DeviceClientContext.Provider value={client}>
      <div className="grid grid-cols-4 gap-3 bg-bg-secondary p-3" style={{ width: 1600 }}>
        {STATES.map(({ label, state }) => (
          <figure key={label} data-testid={`state-${label}`} className="m-0">
            <div className="overflow-hidden rounded border border-border-primary" style={{ height: 560 }}><DevicePanel panel={devicePanel(`d-${label}`, state)} isActive /></div>
            <figcaption className="mt-1 text-xs text-text-secondary">{label}</figcaption>
          </figure>
        ))}
      </div>
    </DeviceClientContext.Provider>,
  );
} else {
  root.render(
    <DeviceClientContext.Provider value={client}>
      <div className="flex bg-bg-primary" style={{ height: '100vh' }}>
        <div className="border-r border-border-primary" style={{ width: 560, height: '100%' }}><ChatTabPanel panelId="chat" client={chatClient} actions={actions} /></div>
        <div className="flex-1"><DevicePanel panel={devicePanel('device', params.get('mac') ? { machine: "Parsa's MacBook Pro", machineReason: { kind: 'automatic', text: "Runs on Parsa's MacBook Pro. This PC has no Xcode." } } : {})} isActive /></div>
      </div>
    </DeviceClientContext.Provider>,
  );
}
