import * as path from 'path';
import { parentPort, Worker, workerData } from 'worker_threads';
import { TerminalStateEmulator } from './terminalStateEmulator';

/**
 * Hosts every panel's TerminalStateEmulator on one worker thread so xterm's
 * parser never runs on Electron's main event loop. The main side talks to it
 * through RemoteTerminalEmulator (terminalEmulatorClient.ts).
 */

/** What the main process can read synchronously from its cached copy. */
export interface ScreenState {
  screenText: string;
  /** screenText with dim cells blanked, so placeholder hints do not read as typed input. */
  inputScreenText: string;
  isAlternateScreen: boolean;
  oscTitle: string;
  oscProgress: string;
}

/**
 * Restore source: the normal buffer serialized with scrollback, or the active
 * alternate screen without it. After dispose it is the final capture, which
 * always includes scrollback.
 */
export interface RestoreSnapshot extends ScreenState {
  serialized: string;
}

/** A request the host answers; the connection tags each with a `req` id. */
export type EmulatorQuery =
  | { op: 'state' | 'restore' | 'dispose'; id: number }
  | { op: 'scrollback'; id: number; maxLines: number };

export type EmulatorRequest =
  | { op: 'create'; id: number; cols: number; rows: number }
  | { op: 'write'; id: number; data: string }
  | { op: 'resize'; id: number; cols: number; rows: number }
  | { op: 'clear'; id: number }
  | (EmulatorQuery & { req: number });

export type EmulatorReply =
  | { op: 'reply'; req: number; state: ScreenState | RestoreSnapshot | null }
  | { op: 'scrollbackReply'; req: number; text: string | null }
  /** Unsolicited: the screen changed. Throttled to STATE_PUSH_MS per terminal. */
  | { op: 'screen'; id: number; state: ScreenState };

/** The main side's view of the emulator thread (a Worker, or a MessagePort in tests). */
export interface EmulatorHost {
  postMessage(message: EmulatorRequest): void;
  on(event: 'message', listener: (message: EmulatorReply) => void): void;
  once(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: () => void): void;
  unref(): void;
}

interface HostPort {
  postMessage(message: EmulatorReply): void;
  on(event: 'message', listener: (message: EmulatorRequest) => void): void;
}

const STATE_PUSH_MS = 50;
const HOST_MARKER = 'pane-terminal-emulators';

function readState(emulator: TerminalStateEmulator): ScreenState {
  return {
    screenText: emulator.getScreenText(),
    inputScreenText: emulator.getScreenText({ omitDim: true }),
    isAlternateScreen: emulator.isAlternateScreen,
    oscTitle: emulator.getOscTitle(),
    oscProgress: emulator.getOscProgress(),
  };
}

function sameState(a: ScreenState | undefined, b: ScreenState): boolean {
  return a !== undefined
    && a.screenText === b.screenText
    && a.inputScreenText === b.inputScreenText
    && a.isAlternateScreen === b.isAlternateScreen
    && a.oscTitle === b.oscTitle
    && a.oscProgress === b.oscProgress;
}

export function serveTerminalEmulators(port: HostPort): void {
  const emulators = new Map<number, TerminalStateEmulator>();
  const lastPushed = new Map<number, ScreenState>();
  const pushTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const pushState = (id: number) => {
    pushTimers.delete(id);
    const emulator = emulators.get(id);
    if (!emulator) return;
    const state = readState(emulator);
    if (sameState(lastPushed.get(id), state)) return;
    lastPushed.set(id, state);
    port.postMessage({ op: 'screen', id, state });
  };

  const schedulePush = (id: number) => {
    if (!pushTimers.has(id)) pushTimers.set(id, setTimeout(() => pushState(id), STATE_PUSH_MS));
  };

  const reply = (req: number, state: ScreenState | RestoreSnapshot | null) => {
    port.postMessage({ op: 'reply', req, state });
  };

  port.on('message', (message) => {
    if (message.op === 'create') {
      emulators.set(message.id, new TerminalStateEmulator(message.cols, message.rows));
      return;
    }
    const emulator = emulators.get(message.id);
    switch (message.op) {
      case 'write':
        emulator?.write(message.data);
        schedulePush(message.id);
        return;
      case 'resize':
        emulator?.resize(message.cols, message.rows);
        schedulePush(message.id);
        return;
      case 'clear':
        emulator?.clearScrollback();
        return;
      case 'scrollback': {
        const { req, maxLines } = message;
        if (!emulator) {
          port.postMessage({ op: 'scrollbackReply', req, text: null });
          return;
        }
        void emulator.waitForIdle().then(() => {
          port.postMessage({ op: 'scrollbackReply', req, text: emulator.getScrollbackText(maxLines) });
        });
        return;
      }
      case 'state':
      case 'restore':
      case 'dispose': {
        if (!emulator) return reply(message.req, null);
        const { id, op, req } = message;
        if (op === 'dispose') {
          emulators.delete(id);
          lastPushed.delete(id);
        }
        // Answer once queued output has landed, as a live read would. After
        // dispose, serializeForRestore returns the final capture with scrollback.
        void emulator.waitForIdle().then(() => {
          if (op === 'dispose') emulator.dispose();
          const state = readState(emulator);
          reply(req, op === 'state'
            ? state
            : { ...state, serialized: emulator.serializeForRestore(!state.isAlternateScreen) });
        });
        return;
      }
    }
  });
}

/** Spawn an emulator thread running this file. */
export function startTerminalEmulatorHost(): EmulatorHost {
  return new Worker(path.join(__dirname, 'terminalEmulatorHost.js'), { name: HOST_MARKER, workerData: HOST_MARKER });
}

// Only the thread spawned above serves; any other worker importing this file does not.
if (parentPort && workerData === HOST_MARKER) {
  serveTerminalEmulators(parentPort);
}
