// Must stay the first import: it captures the browser timers before the Even SDK replaces them.
import { every, later } from './timers';
import { AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { GlassesApp } from './app';
import { DemoSource } from './demo';
import { Display, type Page } from './display';
import { HostHub, STORAGE_KEY, mergePaired, pairComputers, readPaired, type PairedComputer, type PairingFailure } from './host';
import { InputRouter, type Gesture } from './input';
import type { PaneSource } from './model';
import { firstRunPage, pairingFailedPage } from './screens';

const RUNTIME_KEY = 'pane.glasses.runtimeId';
const CLIENT_LABEL = 'Pane glasses';

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`The phone page is missing #${id}.`);
  return found;
}

async function runtimeId(bridge: EvenAppBridge): Promise<string> {
  const stored = await bridge.getLocalStorage(RUNTIME_KEY).catch(() => '');
  if (stored) return stored;
  const created = crypto.randomUUID();
  await bridge.setLocalStorage(RUNTIME_KEY, created).catch(() => false);
  return created;
}

const clock = (epochMs: number) => new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function pageText(page: Page): string {
  return page.boxes.map((box) => (box.kind === 'list' ? box.items.map((item) => `· ${item}`).join('\n') : box.lines.join('\n'))).join('\n────\n');
}

async function main(): Promise<void> {
  const ui = {
    status: element('status', HTMLElement),
    origin: element('origin', HTMLElement),
    form: element('pair', HTMLFormElement),
    code: element('pair-code', HTMLInputElement),
    demo: element('demo', HTMLButtonElement),
    computers: element('computers', HTMLUListElement),
    forget: element('forget', HTMLButtonElement),
    mirror: element('mirror', HTMLPreElement),
  };
  // The Origin the Even app's WebView sends; each computer must allow it (Settings › Remote Access › Glasses).
  console.info(`[Pane glasses] location.origin ${location.origin}`);
  ui.origin.textContent = `This app's origin: ${location.origin}`;

  const bridge = await waitForEvenAppBridge();
  const paired = readPaired(await bridge.getLocalStorage(STORAGE_KEY).catch(() => ''));
  const id = await runtimeId(bridge);
  const display = new Display(bridge);
  display.onPage = (page) => {
    ui.mirror.textContent = pageText(page);
  };

  let target: (gesture: Gesture) => void = () => {};
  const input = new InputRouter((gesture) => {
    if (gesture.type === 'foreground') display.invalidate();
    target(gesture);
  }, () => display.lastWriteAt);
  bridge.onEvenHubEvent((event) => input.handle(event));

  let source: PaneSource | null = null;
  const renderComputers = (failed: readonly PairingFailure[] = []) => {
    ui.computers.replaceChildren();
    for (const computer of source?.computers() ?? []) {
      const row = document.createElement('li');
      const state = computer.status === 'live' ? 'live' : computer.status === 'refused' ? 'refused' : computer.status === 'connecting' ? 'connecting' : 'offline';
      row.innerHTML = '<span class="name"></span><span class="state"></span><p class="why"></p>';
      row.querySelector('.name')?.append(computer.name);
      row.querySelector('.state')?.append(state);
      if (computer.refusal) row.querySelector('.why')?.append(`${computer.refusal.message}${computer.refusal.next ? ` ${computer.refusal.next}` : ''}`);
      else if (computer.hint) row.querySelector('.why')?.append(computer.hint);
      ui.computers.append(row);
    }
    for (const failure of failed) {
      const row = document.createElement('li');
      row.innerHTML = '<span class="name"></span><span class="state">not paired</span><p class="why"></p>';
      row.querySelector('.name')?.append(failure.name);
      row.querySelector('.why')?.append(`${failure.message}${failure.next ? ` ${failure.next}` : ''}`);
      ui.computers.append(row);
    }
  };

  const start = (next: PaneSource) => {
    source = next;
    const app = new GlassesApp({
      source: next,
      show: (page) => void display.show(page),
      exit: () => void bridge.shutDownPageContainer(1),
      mic: (on) => (on ? bridge.audioControl(true, AudioInputSource.Glasses) : bridge.audioControl(false)),
      later,
      now: Date.now,
      clock,
    });
    target = (gesture) => app.handle(gesture);
    next.subscribe(() => renderComputers());
    renderComputers();
  };

  const startDemo = () => {
    ui.demo.hidden = true;
    ui.status.textContent = 'Demo: sample cards and terminals, nothing runs. Paste a pairing code to use your computers.';
    start(new DemoSource(every));
  };

  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    ui.status.textContent = 'Pairing…';
    void pairComputers(ui.code.value, { fetch: (url, init) => fetch(url, init), runtimeId: id, clientLabel: CLIENT_LABEL, origin: location.origin }).then(async (outcome) => {
      if (outcome.paired.length) {
        const all: PairedComputer[] = mergePaired(paired, outcome.paired);
        await bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(all));
      }
      // Pasting the same code again after a partial pairing spends no secret twice: a computer
      // already paired here just reports its secret as used, which is not a failure.
      const pairedUrls = new Set(paired.map((computer) => computer.url));
      const failed = outcome.failed.filter((failure) => !(failure.code === 'ERR_GLASSES_PAIRING_SECRET_INVALID' && pairedUrls.has(failure.url)));
      if (!failed.length) {
        location.reload();
        return;
      }
      // The code stays in the field: its secrets are spent only on success, so it works again within 10 minutes.
      ui.status.textContent = `Paired with ${outcome.paired.length} of ${outcome.paired.length + failed.length} computers.`;
      renderComputers(failed);
      if (!source) void display.show(pairingFailedPage(failed.map((failure) => `${failure.message}${failure.next ? ` ${failure.next}` : ''}`)));
      if (outcome.paired.length) later(() => location.reload(), 8_000);
    }, (error: Error) => {
      ui.status.textContent = error.message;
    });
  });
  ui.demo.addEventListener('click', startDemo);
  ui.forget.addEventListener('click', () => {
    void bridge.setLocalStorage(STORAGE_KEY, '').then(() => location.reload());
  });

  if (paired.length) {
    ui.demo.hidden = true;
    ui.status.textContent = `Paired with ${paired.length} computer${paired.length === 1 ? '' : 's'}. Open Pane from the glasses menu.`;
    const hub = new HostHub(paired, { fetch: (url, init) => fetch(url, init), runtimeId: id, later, now: Date.now, openSocket: (url, protocols) => new WebSocket(url, protocols), origin: location.origin });
    start(hub);
    hub.start();
    return;
  }
  ui.forget.hidden = true;
  ui.status.textContent = 'Not paired. In the Pane app on this phone: Settings › Glasses › Pair glasses, then paste the code here.';
  void display.show(firstRunPage());
  target = (gesture) => {
    if (gesture.type === 'press') startDemo();
    else if (gesture.type === 'double') void bridge.shutDownPageContainer(1);
  };
}

main().catch((error: Error) => {
  console.error(error);
  const status = document.getElementById('status');
  if (status) status.textContent = `Pane couldn't start: ${error.message}`;
});
