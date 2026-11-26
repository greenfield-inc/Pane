/**
 * ⇧↩ answered a card and the column moved on (T-88): while that Enter is still held, its repeats
 * must not answer the next card, wherever focus went. Every Enter keydown is swallowed until
 * Enter comes up (or the window loses focus), so only a fresh press acts again.
 */
let held = false;
const CAPTURE = { capture: true };

export function holdEnterUntilReleased(target: EventTarget = window): void {
  if (held) return;
  held = true;
  const swallow = (event: Event) => {
    if (!isEnter(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const release = (event: Event) => {
    // A keyup of another key leaves Enter held; a blur ends it.
    if (event.type === 'keyup' && !isEnter(event)) return;
    held = false;
    target.removeEventListener('keydown', swallow, CAPTURE);
    target.removeEventListener('keyup', release, CAPTURE);
    target.removeEventListener('blur', release);
  };
  target.addEventListener('keydown', swallow, CAPTURE);
  target.addEventListener('keyup', release, CAPTURE);
  target.addEventListener('blur', release);
}

function isEnter(event: Event): boolean {
  return 'key' in event && event.key === 'Enter';
}

/** Whether a ⇧↩ is still held from an answer it sent. */
export function enterHeld(): boolean {
  return held;
}
