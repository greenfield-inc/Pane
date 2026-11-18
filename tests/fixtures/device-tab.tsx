import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_AGENT_ID, agentLabel } from '../../shared/agents';
import ChatTabPanel from '../../frontend/src/components/chatTab/ChatTabPanel';
import { DevicePanel } from '../../frontend/src/components/panels/device/DevicePanel';
import { DeviceClientContext, type DeviceTabClient } from '../../frontend/src/components/panels/device/deviceClient';
import type { ChatTurnActions } from '../../frontend/src/components/chatTab/ChatTurns';
import type { ChatTabClient, ChatTabView } from '../../shared/types/chatTab';
import type { DeviceControls, DeviceInput, DeviceLogLine, DevicePanelPhase, DevicePanelState } from '../../shared/types/devices';
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

/** The same phone turned to landscape: a sidebar, and a Pay button at the bottom right (x 0.70–0.95, y 0.78–0.92). */
function landscapeScreen(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 874;
  canvas.height = 402;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 874, 402);
  g.fillStyle = '#f2f2f7'; g.fillRect(0, 0, 260, 402);
  g.fillStyle = '#111'; g.font = 'bold 26px -apple-system, sans-serif'; g.fillText('Checkout', 290, 60);
  g.fillStyle = '#111'; g.beginPath(); g.roundRect(612, 314, 218, 56, 14); g.fill();
  g.fillStyle = '#fff'; g.font = '600 17px -apple-system, sans-serif'; g.fillText('Pay $86.00', 676, 348);
  return canvas.toDataURL('image/jpeg', 0.9);
}

declare global { interface Window { qaInputs: DeviceInput[]; qaPower: string[]; qaRotate: () => void; qaStaged: string[]; qaAttached: string[]; qaFinishBoot: () => void; qaSendFirstFrame: () => void } }
window.qaStaged = [];
window.qaAttached = [];
// ?fold=1 is a foldable, half open; otherwise a phone that turns.
const controls: DeviceControls = params.get('fold') ? { orientation: 'portrait', fold: { posture: 'half' } } : { orientation: 'portrait' };
window.qaInputs = [];
window.qaPower = [];
const landscape = landscapeScreen();
const portrait = screen();
// ?shape=landscape starts turned; qaRotate() turns the device mid-session.
let frame = params.get('shape') === 'landscape' ? landscape : portrait;
window.qaRotate = () => { frame = landscape; };
// ?holdFirstFrame=1 holds the first frame, as a device still connecting does, until qaSendFirstFrame().
let sendFirstFrame = () => {};
const firstFrameSent = params.get('holdFirstFrame') ? new Promise<void>(resolve => { sendFirstFrame = resolve; }) : Promise.resolve();
window.qaSendFirstFrame = () => sendFirstFrame();
const client: DeviceTabClient = {
  clientId: 'fixture',
  frame: async () => {
    await firstFrameSent;
    return frame;
  },
  controls: async () => controls,
  capture: async (_panel, image) => ({ path: '/tmp/pane/devices/screenshots/pane-1.png', dataUrl: image ?? frame }),
  stage: async (_panel, agentPanelId, text) => { window.qaStaged.push(`${agentPanelId}:${text}`); },
  attachToChat: async (chatPanelId, file) => { window.qaAttached.push(`${chatPanelId}:${file.name}`); },
  record: async (_panel, action) => (action === 'start' ? null : { path: '/tmp/pane/devices/recordings/pane-1.mp4' }),
  recording: async () => null,
  // ?logs=many sends 400 lines, as a chatty app does.
  logs: async (_panel, since) => {
    const lines = params.get('logs') === 'many' ? Array.from({ length: 400 }, (_, index) => ({ ...LOG_LINES[index % 3], seq: index + 1 })) : LOG_LINES;
    return { lines: since > 0 ? [] : lines, next: lines.length };
  },
  driver: async (_panel, who) => { window.qaPower.push(`driver:${who}`); },
  input: async (_panel, input) => { window.qaInputs.push(input); },
  visible: async () => undefined,
  takeOver: async () => { window.qaPower.push('take-over'); },
  power: async (_panel, action) => { window.qaPower.push(action); },
};

const LOG_LINES: DeviceLogLine[] = [
  { seq: 1, at: Date.parse('2026-11-16T19:04:11.208Z'), level: 'info', source: 'Shop', message: 'Checkout: mounted step 1 of 3' },
  { seq: 2, at: Date.parse('2026-11-16T19:04:13.044Z'), level: 'warning', source: 'Shop', message: 'VirtualizedList is slow to update' },
  { seq: 3, at: Date.parse('2026-11-16T19:04:15.020Z'), level: 'error', source: 'Shop', message: 'image cache miss for cover@3x.png' },
];

/** The Pane's agent tab beside the device: a chat (?agent=chat, the default) or a Claude Code terminal (?agent=terminal). */
const agentPanel: ToolPanel = params.get('agent') === 'terminal'
  ? { id: 'agent', sessionId: 'pane', type: 'terminal', title: agentLabel(DEFAULT_AGENT_ID), state: { isActive: false, customState: { agentType: DEFAULT_AGENT_ID } }, metadata: { createdAt: '2026-11-15T00:00:00.000Z', lastActiveAt: '2026-11-15T00:00:00.000Z', position: 0 } }
  : { id: 'chat', sessionId: 'pane', type: 'chat', title: agentLabel(DEFAULT_AGENT_ID), state: { isActive: false, customState: { agent: DEFAULT_AGENT_ID } }, metadata: { createdAt: '2026-11-15T00:00:00.000Z', lastActiveAt: '2026-11-15T00:00:00.000Z', position: 0 } };
const driver: DevicePanelState['driver'] = params.get('driver') === 'agent' ? { by: 'agent', agent: agentLabel(DEFAULT_AGENT_ID) } : params.get('driver') === 'person' ? { by: 'person', agentWaiting: agentLabel(DEFAULT_AGENT_ID) } : undefined;

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
  { label: 'Runs on a linked Mac', state: { machine: "Studio MacBook Pro", machineId: 'mbp', machineReason: { kind: 'automatic', text: "Runs on Studio MacBook Pro. This PC has no Xcode." } } },
  { label: 'No Mac linked', state: { phase: 'no-mac', name: 'iPhone', machine: 'This PC' } },
  { label: 'Linked Mac offline', state: { phase: 'mac-offline', name: 'iPhone', machine: 'This PC', macName: "Studio MacBook Pro" } },
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

/** The device tab beside the chat: ?mac runs it on a linked Mac, ?driver shows who drives, ?fold makes it a foldable. */
const paneState: Partial<DevicePanelState> = {};
if (params.get('mac')) {
  paneState.machine = 'Studio MacBook Pro';
  paneState.machineReason = { kind: 'automatic', text: 'Runs on Studio MacBook Pro. This PC has no Xcode.' };
}
if (driver) paneState.driver = driver;
if (params.get('fold')) {
  paneState.name = 'Pixel Fold';
  paneState.os = 'Android 16';
}

/** ?view=boot: the tab boots until qaFinishBoot(), then goes live. */
function BootingTab() {
  const [phase, setPhase] = useState<DevicePanelPhase>('booting');
  useEffect(() => {
    window.qaFinishBoot = () => setPhase('live');
  }, []);
  return <DevicePanel panel={devicePanel('device', { ...paneState, phase })} panels={[agentPanel]} isActive />;
}

const root = createRoot(document.getElementById('root')!);
if (params.get('view') === 'boot') {
  root.render(
    <DeviceClientContext.Provider value={client}>
      <div className="flex bg-bg-primary" style={{ height: '100vh' }}>
        <div className="border-r border-border-primary" style={{ width: 560, height: '100%' }}><ChatTabPanel panelId="chat" client={chatClient} actions={actions} /></div>
        <div className="flex-1"><BootingTab /></div>
      </div>
    </DeviceClientContext.Provider>,
  );
} else if (params.get('view') === 'states') {
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
} else if (params.get('view') === 'phone') {
  root.render(
    <DeviceClientContext.Provider value={client}>
      <div className="bg-bg-primary" style={{ width: 390, height: '100vh' }}>
        <DevicePanel panel={devicePanel('device', driver ? { driver } : {})} panels={[agentPanel]} isActive />
      </div>
    </DeviceClientContext.Provider>,
  );
} else {
  root.render(
    <DeviceClientContext.Provider value={client}>
      <div className="flex bg-bg-primary" style={{ height: '100vh' }}>
        <div className="border-r border-border-primary" style={{ width: 560, height: '100%' }}><ChatTabPanel panelId="chat" client={chatClient} actions={actions} /></div>
        <div className="flex-1"><DevicePanel panel={devicePanel('device', paneState)} panels={[agentPanel]} isActive /></div>
      </div>
    </DeviceClientContext.Provider>,
  );
}
