import { NativeModule, requireOptionalNativeModule } from 'expo';

/** A button by the platform's own name: Android's KEYCODE_BUTTON_A or Apple's buttonA is 'a'. */
export type RawButton =
  | 'a' | 'b' | 'x' | 'y'
  | 'l1' | 'r1' | 'l2' | 'r2' | 'l3' | 'r3'
  | 'select' | 'start'
  | 'up' | 'down' | 'left' | 'right';

/** Stick positions, -1..1, with +Y down. */
export interface RawAxes {
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}

export interface RawDevice {
  id: string;
  name?: string;
  /** Android only; 0 when the device doesn't say. */
  vendorId?: number;
  productId?: number;
  /** iPhone only: GCController.productCategory ("DualSense", "Xbox One", "Switch Pro Controller", …). */
  appleCategory?: string;
  hasRumble?: boolean;
}

export type DeviceEvent = { type: 'connect'; device: RawDevice } | { type: 'disconnect'; device: { id: string } };
export interface ButtonEvent { deviceId: string; button: RawButton; pressed: boolean }
export interface AxesEvent { deviceId: string; axes: RawAxes }

declare class PaneControllerNativeModule extends NativeModule<{
  onDevice: (event: DeviceEvent) => void;
  onButton: (event: ButtonEvent) => void;
  onAxes: (event: AxesEvent) => void;
}> {
  available: boolean;
  devices(): RawDevice[];
  rumble(deviceId: string, durationMs: number, strength: number): boolean;
}

const native = requireOptionalNativeModule<PaneControllerNativeModule>('PaneController');

/** False in builds without the module (runtime 1.5 and older, Expo Go). */
export const controllerAvailable = native?.available ?? false;

export interface ControllerListeners {
  onDevice(event: DeviceEvent): void;
  onButton(event: ButtonEvent): void;
  onAxes(event: AxesEvent): void;
}

/** Starts reading controllers; the native side reads nothing while no one listens. */
export function listen(listeners: ControllerListeners): { remove(): void } {
  if (!native) return { remove: () => undefined };
  const subscriptions = [
    native.addListener('onDevice', listeners.onDevice),
    native.addListener('onButton', listeners.onButton),
    native.addListener('onAxes', listeners.onAxes),
  ];
  return { remove: () => subscriptions.forEach(subscription => subscription.remove()) };
}

export function connectedDevices(): RawDevice[] {
  return native?.devices() ?? [];
}

/** A short pulse on pads that can rumble; false when the pad can't. */
export function rumble(deviceId: string, durationMs = 120, strength = 0.6): boolean {
  return native?.rumble(deviceId, durationMs, strength) ?? false;
}
