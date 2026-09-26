/** Result of feeding input data to the interceptor */
export interface InterceptResult {
  consumed: boolean; // true = interceptor handled it, don't send to PTY
}

/** State exposed by the interceptor for UI rendering */
export interface InterceptorState {
  active: boolean;
  triggerChar: string | null;
  buffer: string; // characters typed after trigger (for filtering)
  // Handler-specific UI state passed opaquely
  handlerState: AtTerminalHandlerState | null;
}

/** A pluggable handler for a trigger character */
export interface InterceptHandler {
  /** Called when the trigger character is typed. Return false to pass through (e.g., no other terminals). */
  onActivate: () => boolean;
  /** Called for each subsequent keystroke while active. Returns action to take. */
  onInput: (data: string, buffer: string) => InterceptAction;
  /** Clean up when deactivating */
  onDeactivate: () => void;
  /** Get current handler-specific state for UI rendering */
  getState: () => AtTerminalHandlerState;
}

/** Actions a handler can return from onInput */
export type InterceptAction =
  | { type: 'consume' } // eat the keystroke, stay active
  | { type: 'cancel'; consumeInput?: boolean } // flush held text; optionally consume the cancel key
  | { type: 'dismiss' } // dismiss silently — deactivate WITHOUT flushing (e.g. backspace on empty)
  | { type: 'execute'; payload: InterceptPayload } // execute action, deactivate
  | { type: 'update'; buffer: string }; // update filter buffer, stay active

/** Payload when executing an action */
interface InterceptPayload {
  action: string;
  data: JsonObject;
}

/** Preset line count options for the line count selector */
export const LINE_COUNT_PRESETS = [100, 300, 500, -1] as const; // -1 = All
/** Paste mode: raw pastes text into PTY, embed saves to file and inserts path */
export type PasteMode = 'raw' | 'embed';

/** State specific to the @ terminal handler */
export interface AtTerminalHandlerState {
  terminals: TerminalSuggestion[];
  selectedIndex: number;
  lineCountPresetIndex: number; // index into LINE_COUNT_PRESETS (default 2 = 500)
  lineCount: number; // resolved value (500, or -1 for all)
  pasteMode: PasteMode; // default 'raw'
}

/** A terminal suggestion in the dropdown */
export interface TerminalSuggestion {
  panelId: string;
  title: string;
  preview: string[]; // last 3 clean lines, ANSI-stripped
}
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';
