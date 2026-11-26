/**
 * Reads game controllers through the Gamepad API and feeds them to the shared
 * interpreter (shared/controller). It polls on animation frames only while a
 * pad is connected and the window is focused and visible, and skips a frame
 * the pad didn't change unless a hold or repeat is pending, so an idle pad
 * costs no work past reading its timestamp.
 *
 * Chromium numbers a standard-mapped pad by position: 0 to 3 are bottom,
 * right, left and top, 4/5 shoulders, 6/7 triggers, 8/9 select/start, 10/11
 * stick clicks, 12 to 15 the D-pad. A pad Chromium has no layout for
 * (`mapping === ''`) is read as unrecognised and drives nothing.
 */
import type { ControllerContext } from '../../../shared/controller/bindings';
import { createControllerInterpreter, type ControllerEvent, type ControllerInterpreter } from '../../../shared/controller/interpreter';
import { deviceFromGamepadId, resolveFamily, type ButtonLettersOverride, type ControllerFamily } from '../../../shared/controller/profiles';
import type { ControllerButton, ControllerDevice, ControllerFrame } from '../../../shared/controller/types';

const STANDARD_BUTTONS: readonly ControllerButton[] = [
  'south', 'east', 'west', 'north', 'l1', 'r1', 'l2', 'r2', 'select', 'start', 'l3', 'r3', 'up', 'down', 'left', 'right',
];
/** Analog triggers count as pressed past half travel. */
const TRIGGER_PRESSED = 0.5;

export interface GamepadAdapterHandlers {
  /** A pad (re)connected or its family changed; also called once per press-free pad on start. */
  onDevice(device: ControllerDevice, family: ControllerFamily): void;
  /** Any button went down on a pad that drives Pane. Runs before the events of that frame. */
  onInput(device: ControllerDevice, family: ControllerFamily): void;
  onEvents(events: ControllerEvent[]): void;
  onDisconnect(device: ControllerDevice): void;
  context(): ControllerContext;
  lettersOverride(): ButtonLettersOverride;
}

interface PadState {
  device: ControllerDevice;
  family: ControllerFamily;
  interpreter: ControllerInterpreter;
  timestamp: number;
  pressedCount: number;
}

function frameFromGamepad(pad: Pick<Gamepad, 'buttons' | 'axes'>): ControllerFrame {
  const buttons = new Set<ControllerButton>();
  STANDARD_BUTTONS.forEach((button, index) => {
    const state = pad.buttons[index];
    if (!state) return;
    const isTrigger = button === 'l2' || button === 'r2';
    if (state.pressed && (!isTrigger || state.value === 0 || state.value >= TRIGGER_PRESSED)) buttons.add(button);
  });
  const axis = (index: number) => pad.axes[index] ?? 0;
  return { buttons, axes: { leftX: axis(0), leftY: axis(1), rightX: axis(2), rightY: axis(3) } };
}

function padsOnline(): Gamepad[] {
  return Array.from(navigator.getGamepads?.() ?? []).filter((pad): pad is Gamepad => Boolean(pad?.connected));
}

export interface GamepadAdapter {
  stop(): void;
  /** Re-reads the letters override (Settings › Controller) for every pad. */
  refreshFamilies(): void;
  /** A short pulse on the pad last used, where it supports one. */
  rumble(): void;
}

export function startGamepadAdapter(handlers: GamepadAdapterHandlers): GamepadAdapter {
  const pads = new Map<number, PadState>();
  let frameRequest: number | null = null;
  let lastUsed: number | null = null;

  function stateFor(pad: Gamepad): PadState {
    const existing = pads.get(pad.index);
    if (existing && existing.device.id === pad.id) return existing;
    const device = deviceFromGamepadId(pad.id, pad.mapping, Boolean(pad.vibrationActuator));
    const family = resolveFamily(device, handlers.lettersOverride());
    const state: PadState = { device, family, interpreter: createControllerInterpreter({ family }), timestamp: -1, pressedCount: 0 };
    pads.set(pad.index, state);
    handlers.onDevice(device, family);
    return state;
  }

  function poll(now: number) {
    frameRequest = null;
    for (const pad of padsOnline()) {
      const state = stateFor(pad);
      if (state.family === 'unrecognised') {
        if (pad.timestamp !== state.timestamp && pad.buttons.some(button => button.pressed)) handlers.onInput(state.device, state.family);
        state.timestamp = pad.timestamp;
        continue;
      }
      if (pad.timestamp === state.timestamp && !state.interpreter.needsTick()) continue;
      state.timestamp = pad.timestamp;
      const frame = frameFromGamepad(pad);
      if (frame.buttons.size > state.pressedCount) {
        lastUsed = pad.index;
        handlers.onInput(state.device, state.family);
      }
      state.pressedCount = frame.buttons.size;
      const events = state.interpreter.update(frame, now, handlers.context());
      if (events.length > 0) handlers.onEvents(events);
    }
    schedule();
  }

  function shouldPoll(): boolean {
    return pads.size > 0 && document.visibilityState === 'visible' && document.hasFocus();
  }

  function schedule() {
    if (frameRequest === null && shouldPoll()) frameRequest = requestAnimationFrame(poll);
  }

  /** Ends any hold a pad had going, so leaving the window never leaves dictation running. */
  function releaseAll() {
    const now = performance.now();
    for (const state of pads.values()) {
      const events = state.interpreter.update({ buttons: new Set(), axes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 } }, now, handlers.context());
      state.pressedCount = 0;
      if (events.length > 0) handlers.onEvents(events.filter(event => event.type === 'hold-end'));
    }
  }

  function pause() {
    if (frameRequest !== null) cancelAnimationFrame(frameRequest);
    frameRequest = null;
    releaseAll();
  }

  const onConnect = (event: GamepadEvent) => {
    stateFor(event.gamepad);
    schedule();
  };
  const onDisconnectEvent = (event: GamepadEvent) => {
    const state = pads.get(event.gamepad.index);
    if (!state) return;
    const events = state.interpreter.update({ buttons: new Set(), axes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 } }, performance.now(), handlers.context());
    if (events.length > 0) handlers.onEvents(events.filter(item => item.type === 'hold-end'));
    pads.delete(event.gamepad.index);
    if (lastUsed === event.gamepad.index) lastUsed = null;
    handlers.onDisconnect(state.device);
  };
  const onFocusChange = () => (shouldPoll() ? schedule() : pause());

  window.addEventListener('gamepadconnected', onConnect);
  window.addEventListener('gamepaddisconnected', onDisconnectEvent);
  window.addEventListener('focus', onFocusChange);
  window.addEventListener('blur', onFocusChange);
  document.addEventListener('visibilitychange', onFocusChange);
  // Pads that were connected (and pressed) before this renderer loaded.
  for (const pad of padsOnline()) stateFor(pad);
  schedule();

  return {
    stop() {
      pause();
      window.removeEventListener('gamepadconnected', onConnect);
      window.removeEventListener('gamepaddisconnected', onDisconnectEvent);
      window.removeEventListener('focus', onFocusChange);
      window.removeEventListener('blur', onFocusChange);
      document.removeEventListener('visibilitychange', onFocusChange);
    },
    refreshFamilies() {
      for (const [index, state] of pads) {
        const family = resolveFamily(state.device, handlers.lettersOverride());
        if (family === state.family) continue;
        pads.set(index, { ...state, family, interpreter: createControllerInterpreter({ family }), pressedCount: 0 });
        handlers.onDevice(state.device, family);
      }
    },
    rumble() {
      const pad = lastUsed === null ? null : navigator.getGamepads?.()[lastUsed];
      void pad?.vibrationActuator?.playEffect('dual-rumble', { duration: 120, strongMagnitude: 0.4, weakMagnitude: 0.6 })
        .catch(() => undefined);
    },
  };
}
