// Pane's phone screen in the Glassly app: pairing, the paired computers and what the glasses show.
import type { PhoneCommand, PhoneState } from '../channels';

/** The part of Glassly's injected `glassly` bus this screen uses, with Pane's two channels. */
interface GlasslyBus {
  send(channel: 'command', payload: PhoneCommand): void;
  on(channel: 'state', handler: (payload: PhoneState) => void): () => void;
}

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`The phone screen is missing #${id}.`);
  return found;
}

// SAFETY: Glassly injects `glassly` into its miniapp WebViews before content loads; the background
// sends PhoneState on `state` and reads PhoneCommand on `command`, both defined in ../channels.
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
};
const command = (value: PhoneCommand) => bus?.send('command', value);

function render(state: PhoneState): void {
  ui.status.textContent = state.status;
  ui.demo.hidden = state.paired > 0 || state.demo;
  ui.forget.hidden = state.paired === 0;
  ui.ambient.checked = state.ambient;
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
  ui.pair.addEventListener('click', () => {
    const code = ui.code.value.trim();
    if (code) command({ type: 'pair', code });
  });
  ui.demo.addEventListener('click', () => command({ type: 'demo' }));
  ui.forget.addEventListener('click', () => command({ type: 'forget' }));
  ui.ambient.addEventListener('change', () => command({ type: 'ambient', on: ui.ambient.checked }));
  command({ type: 'hello' });
}
