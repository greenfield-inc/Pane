import { MessageChannel } from 'worker_threads';
import { TerminalEmulatorHostConnection } from '../services/terminalEmulatorClient';
import { serveTerminalEmulators } from '../services/terminalEmulatorHost';

/**
 * Vitest runs TypeScript sources, which a real Worker cannot load. Serve the
 * emulator protocol in-process over a MessageChannel instead, so tests still
 * cross the same structured-clone message boundary as production.
 */
export function inProcessEmulatorHost(): TerminalEmulatorHostConnection {
  const { port1, port2 } = new MessageChannel();
  serveTerminalEmulators(port2);
  port2.unref();
  return new TerminalEmulatorHostConnection(port1);
}
