// Pane's phone screen in the Glassly app: pairing, the paired computers and what the glasses show.
import type { PhoneCommand, PhoneFrame, PhoneState } from '../channels';
import { frameSvg } from '../frameSvg';

/** The part of Glassly's injected `glassly` bus this screen uses, with Pane's two channels. */
interface GlasslyBus {
  send(channel: 'command', payload: PhoneCommand): void;
  on(channel: 'state', handler: (payload: PhoneState) => void): () => void;
  on(channel: 'frame', handler: (payload: PhoneFrame) => void): () => void;
}

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`The phone screen is missing #${id}.`);
  return found;
}

// SAFETY: Glassly injects `glassly` into its miniapp WebViews before content loads; the background
// sends PhoneState on `state` and PhoneFrame on `frame`, and reads PhoneCommand on `command` (../channels).
const bus = (globalThis as { glassly?: GlasslyBus }).glassly;
const ui = {
  status: element('status', HTMLParagraphElement),
  pairing: element('pairing', HTMLElement),
  code: element('code', HTMLTextAreaElement),
  pair: element('pair', HTMLButtonElement),
  demo: element('demo', HTMLButtonElement),
  computers: element('computers', HTMLUListElement),
  ambient: element('ambient', HTMLInputElement),
  forget: element('forget', HTMLButtonElement),
  mirror: element('mirror', HTMLPreElement),
  mirrorSection: element('mirror-section', HTMLElement),
  frame: element('frame', HTMLDivElement),
  readAloud: element('read-aloud', HTMLInputElement),
};
const command = (value: PhoneCommand) => bus?.send('command', value);

function render(state: PhoneState): void {
  ui.status.textContent = state.status;
  ui.demo.hidden = state.paired > 0 || state.demo;
  ui.forget.hidden = state.paired === 0;
  ui.ambient.checked = state.ambient;
  ui.readAloud.checked = state.readAloud;
  ui.mirror.textContent = state.mirror;
  ui.mirrorSection.hidden = !state.mirror;
  ui.computers.replaceChildren(...state.computers.map((computer) => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = computer.name;
    const status = document.createElement('span');
    status.className = `state ${computer.state.replace(' ', '-')}`;
    status.textContent = computer.state;
    row.append(name, status);
    if (computer.why) {
      const why = document.createElement('p');
      why.className = 'why';
      why.textContent = computer.why;
      row.append(why);
    }
    return row;
  }));
}

if (!bus) {
  ui.status.textContent = "This page runs inside the Glassly app. Open Pane there.";
} else {
  bus.on('state', render);
  // The live mirror: Pane's own frames as the glasses draw them; the text mirror stays as a fallback.
  bus.on('frame', (frame) => {
    // The SVG comes from frameSvg, which escapes every piece of text it draws.
    ui.frame.innerHTML = frameSvg(frame.elements, frame.width, frame.height);
    ui.mirror.hidden = true;
    ui.mirrorSection.hidden = false;
  });
  ui.readAloud.addEventListener('change', () => command({ type: 'read-aloud', on: ui.readAloud.checked }));
  ui.pair.addEventListener('click', () => {
    const code = ui.code.value.trim();
    if (code) command({ type: 'pair', code });
  });
  ui.demo.addEventListener('click', () => command({ type: 'demo' }));
  ui.forget.addEventListener('click', () => command({ type: 'forget' }));
  ui.ambient.addEventListener('change', () => command({ type: 'ambient', on: ui.ambient.checked }));
  command({ type: 'hello' });
}
