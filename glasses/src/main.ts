// Must stay the first import: it captures the browser timers before the Even SDK replaces them.
import { every, later } from './timers';
import { AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { GlassesApp } from './app';
import { DemoSource } from './demo';
import { Display, type Page } from './display';
import { CLIENT_LABEL, HostHub, STORAGE_KEY, pairComputers, pairedSaver, readPaired, type PairingFailure } from './host';
import { InputRouter, type Gesture } from './input';
import type { PaneSource } from './model';
import { firstRunPage, pairingFailedPage } from './screens';

const RUNTIME_KEY = 'pane.glasses.runtimeId';

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
  return page.boxes.flatMap((box) => (box.kind === 'list' ? [box.items.map((item) => `· ${item}`).join('\n')] : box.kind === 'text' ? [box.lines.join('\n')] : [])).join('\n────\n');
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
  // Swipe timing for real G2 (check G19): each swipe's page logs the time from the swipe event to
  // the glasses' acknowledgment of the last write it needed, and what that write sent.
  let swipe: { dir: string; at: number } | null = null;
  const input = new InputRouter((gesture) => {
    if (gesture.type === 'foreground') display.invalidate();
    if (gesture.type === 'up' || gesture.type === 'down') swipe = { dir: gesture.type, at: performance.now() };
    target(gesture);
    swipe = null;
  }, () => display.lastWriteAt);
  const show = (page: Page) => {
    const timed = swipe;
    swipe = null;
    void display.show(page).then(() => {
      if (!timed) return;
      const { rebuilt, texts, images } = display.lastWrite;
      console.info(`[Pane glasses] swipe ${timed.dir} → display ack ${Math.round(performance.now() - timed.at)} ms (${rebuilt ? 'rebuild' : `${texts} text`}, ${images} image)`);
    });
  };
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
      show,
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

  // Shared by a pasted code and computers that join on their own.
  const savePaired = pairedSaver(bridge);

  ui.form.addEventListener('submit', (event) => {
    event.preventDefault();
    ui.status.textContent = 'Pairing…';
    void pairComputers(ui.code.value, { fetch: (url, init) => fetch(url, init), runtimeId: id, clientLabel: CLIENT_LABEL, origin: location.origin }).then(async (outcome) => {
      if (outcome.paired.length) {
        await savePaired(outcome.paired);
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
    const hub = new HostHub(paired, {
      fetch: (url, init) => fetch(url, init),
      runtimeId: id,
      later,
      now: Date.now,
      openSocket: (url, protocols) => new WebSocket(url, protocols),
      origin: location.origin,
      savePaired,
    });
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
