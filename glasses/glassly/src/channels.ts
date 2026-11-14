// What the background and Pane's phone screen in the Glassly app say to each other.
import type { FrameElement } from './frameSvg';

/** One paired computer as the phone screen lists it. */
export interface PhoneComputer {
  name: string;
  state: 'live' | 'connecting' | 'offline' | 'refused' | 'not paired';
  why: string;
}

/** Background → phone screen, on channel `state`, whenever anything on it changes. */
export interface PhoneState {
  status: string;
  paired: number;
  demo: boolean;
  ambient: boolean;
  computers: PhoneComputer[];
  /** What the glasses show, as text. */
  mirror: string;
  /** Speak each new question from the phone or Bluetooth headphones (off by default). */
  readAloud: boolean;
}

/** Background → phone screen, on channel `frame`: each frame Pane draws on the glasses, as drawn. */
export interface PhoneFrame {
  width: number;
  height: number;
  elements: FrameElement[];
}

/** Phone screen → background, on channel `command`. */
export type PhoneCommand =
  | { type: 'hello' }
  | { type: 'pair'; code: string }
  | { type: 'forget' }
  | { type: 'demo' }
  | { type: 'ambient'; on: boolean }
  | { type: 'read-aloud'; on: boolean };
