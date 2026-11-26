import { useRouter } from 'expo-router';
import { useEffect, useEffectEvent } from 'react';
import { Platform } from 'react-native';

import type { ControllerActionId, ControllerContext } from '@shared/controller/bindings';
import { createControllerInterpreter, type ControllerInterpreter } from '@shared/controller/interpreter';
import { resolveFamily } from '@shared/controller/profiles';
import { RESTING_AXES, type ControllerAxes, type ControllerButton, type ControllerDevice } from '@shared/controller/types';

import * as pads from '../../../modules/pane-controller';

import { useWideLayout } from '../layout/wideLayout';

import { useControllerState } from './controllerState';
import type { Direction } from './focusRegistry';
import { namesByLabel, toPosition } from './positions';
import { activePad, controllerActions, controllerFocus, type ControllerActionEvent } from './runtime';

const TICK_MS = 16;
/** After a step at a list's edge, the new rows have mounted by then. */
const EDGE_RETRY_MS = 120;
const FOCUS_MOVES: Partial<Record<ControllerActionId, Direction>> = {
  'controller-focus-up': 'up',
  'controller-focus-down': 'down',
  'controller-focus-left': 'left',
  'controller-focus-right': 'right',
};

function toDevice(raw: pads.RawDevice): ControllerDevice {
  const hex = (value?: number) => (value ? value.toString(16).padStart(4, '0') : undefined);
  return {
    id: raw.id,
    name: raw.name ?? '',
    vendorId: hex(raw.vendorId),
    productId: hex(raw.productId),
    appleCategory: raw.appleCategory,
    hasRumble: raw.hasRumble ?? false,
  };
}

/**
 * Reads the pane-controller module and runs the approved scheme: positions
 * become the pad's printed letters, the shared interpreter turns presses,
 * holds and sticks into actions, and the newest screen's handlers run them.
 * Moving focus, A on a focused control and B as Back work everywhere without
 * a screen handler. Mounted once, for the signed-in app.
 */
export function ControllerInput() {
  const router = useRouter();
  const letters = useControllerState(state => state.letters);

  const fallback = useEffectEvent((action: ControllerActionId) => {
    const direction = FOCUS_MOVES[action];
    if (direction) {
      if (controllerFocus.move(direction) === 'scrolled') setTimeout(() => controllerFocus.move(direction), EDGE_RETRY_MS);
      return;
    }
    const layout = useWideLayout.getState();
    // A with nothing focused puts the ring on the screen's first control.
    if (action === 'controller-activate') {
      if (!controllerFocus.activate()) controllerFocus.move('down');
    }
    else if (action === 'controller-back') {
      if (router.canGoBack()) router.back();
      // Wide, the first screen beside Home goes nowhere: B moves the ring into Home's column instead.
      else if (layout.wide) controllerFocus.move('left');
    } else if (action === 'toggle-sidebar') {
      if (layout.wide) layout.setCollapsed(!layout.collapsed);
      else if (router.canGoBack()) router.dismissTo('/');
    }
  });

  useEffect(() => {
    if (!pads.controllerAvailable) return;
    const platform = Platform.OS === 'ios' ? 'ios' : 'android';
    const devices = new Map<string, pads.RawDevice>(pads.connectedDevices().map(device => [device.id, device]));
    const held = new Set<ControllerButton>();
    let axes: ControllerAxes = RESTING_AXES;
    let deviceId: string | null = null;
    let interpreter: ControllerInterpreter | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const context = (): ControllerContext =>
      (controllerFocus.focused()?.context as ControllerContext | undefined) ?? controllerActions.context('home');

    const run = (action: ControllerActionId, event: ControllerActionEvent) => {
      if (!controllerActions.dispatch(action, event)) fallback(action);
    };

    const step = () => {
      if (!interpreter) return;
      for (const event of interpreter.update({ buttons: held, axes }, Date.now(), context())) {
        if (event.type === 'action') run(event.action, {});
        else if (event.action === 'show-controller-help') {
          useControllerState.setState({ cheatSheet: event.type === 'hold-start' ? 'held' : null });
        } else run(event.action, { phase: event.type === 'hold-start' ? 'start' : 'end' });
      }
      const ticking = interpreter.needsTick();
      if (ticking && !timer) timer = setInterval(step, TICK_MS);
      if (!ticking && timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    /** The pad that pressed last drives Pane; switching pads starts its letters afresh. */
    const use = (id: string) => {
      if (id === deviceId && interpreter) return;
      deviceId = id;
      held.clear();
      axes = RESTING_AXES;
      const raw = devices.get(id) ?? { id };
      const family = resolveFamily(toDevice(raw), letters);
      interpreter = createControllerInterpreter({ family });
      activePad.id = id;
      activePad.hasRumble = raw.hasRumble ?? false;
      const state = useControllerState.getState();
      useControllerState.setState({ active: true, family, ringShown: true });
      if (!state.sheetSeen) {
        state.markSheetSeen();
        useControllerState.setState({ cheatSheet: 'open' });
      }
    };

    const subscription = pads.listen({
      onDevice(event) {
        if (event.type === 'connect') {
          devices.set(event.device.id, event.device);
          return;
        }
        devices.delete(event.device.id);
        if (event.device.id !== deviceId) return;
        deviceId = null;
        interpreter = null;
        activePad.id = null;
        if (timer) clearInterval(timer);
        timer = null;
        useControllerState.setState({ active: devices.size > 0, ringShown: false, cheatSheet: null });
      },
      onButton(event) {
        use(event.deviceId);
        // The cheat sheet that opened on its own, or from Settings, closes on the next press, which does nothing else.
        if (event.pressed && useControllerState.getState().cheatSheet === 'open') {
          useControllerState.setState({ cheatSheet: null });
          return;
        }
        const position = toPosition(event.button, namesByLabel(platform, devices.get(event.deviceId)));
        if (event.pressed) held.add(position);
        else held.delete(position);
        if (event.pressed) useControllerState.setState({ ringShown: true });
        step();
      },
      onAxes(event) {
        if (event.deviceId !== deviceId) {
          // Resting sticks on another pad don't take over.
          if (Math.max(...Object.values(event.axes).map(Math.abs)) < 0.5) return;
          use(event.deviceId);
        }
        axes = event.axes;
        step();
      },
    });
    return () => {
      subscription.remove();
      if (timer) clearInterval(timer);
    };
  }, [letters]);

  return null;
}
