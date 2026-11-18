// Unit tests run with Vitest's isolation off: one worker process runs many test
// files in turn, so whatever a file leaves behind becomes the next file's
// starting state. Each project's setup file calls guardFileState() at the start
// of every test file. It records the process state a file must leave as it
// found it; after the file's last hook it restores that state, so the next file
// starts clean, and fails the file for anything it had to restore.
//
// Vitest is passed in rather than imported: main and frontend use different
// Vitest versions, and a bare import from shared/ would resolve to the wrong one.

interface VitestHandles {
  afterAll(fn: () => void): void;
  vi: {
    isFakeTimers(): boolean;
    useRealTimers(): void;
    unstubAllEnvs(): void;
    unstubAllGlobals(): void;
  };
}

const PROCESS_EVENTS = [
  'exit',
  'beforeExit',
  'uncaughtException',
  'unhandledRejection',
  'warning',
  'SIGINT',
  'SIGTERM',
] as const;

type Listener = (...args: unknown[]) => void;

export function guardFileState({ afterAll, vi }: VitestHandles): void {
  const env = { ...process.env };
  const cwd = process.cwd();
  const globals = new Map<PropertyKey, PropertyDescriptor | undefined>(
    Reflect.ownKeys(globalThis).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const listeners = new Map<string, Listener[]>(PROCESS_EVENTS.map((event) => [event, processListeners(event)]));

  afterAll(() => {
    // vi.stubEnv and vi.stubGlobal are the clean way to change these, so their
    // stubs are undone here rather than reported.
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    const leaks: string[] = [];

    if (vi.isFakeTimers()) {
      vi.useRealTimers();
      leaks.push('fake timers are still installed (call vi.useRealTimers())');
    }

    for (const name of new Set([...Object.keys(env), ...Object.keys(process.env)])) {
      if (process.env[name] === env[name]) continue;
      leaks.push(`process.env.${name} changed (use vi.stubEnv, or restore it yourself)`);
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }

    if (process.cwd() !== cwd) {
      leaks.push(`the working directory moved to ${process.cwd()}`);
      process.chdir(cwd);
    }

    for (const key of Reflect.ownKeys(globalThis)) {
      if (globals.has(key)) continue;
      leaks.push(`globalThis.${String(key)} was added (use vi.stubGlobal, or delete it yourself)`);
      Reflect.deleteProperty(globalThis, key);
    }
    for (const [key, before] of globals) {
      const now = Object.getOwnPropertyDescriptor(globalThis, key);
      if (before === undefined || now === undefined) {
        if (before !== now) {
          leaks.push(`globalThis.${String(key)} was deleted`);
          if (before) Object.defineProperty(globalThis, key, before);
        }
        continue;
      }
      if ('value' in before && now.value !== before.value) {
        leaks.push(`globalThis.${String(key)} was replaced (use vi.stubGlobal, or restore it yourself)`);
        Object.defineProperty(globalThis, key, before);
      }
    }

    for (const [event, before] of listeners) {
      for (const listener of processListeners(event)) {
        if (before.includes(listener)) continue;
        leaks.push(`a process '${event}' listener was left registered`);
        process.removeListener(event, listener);
      }
    }

    if (leaks.length > 0) {
      throw new Error(
        `This test file left shared state behind, and the next file in this worker would have inherited it:\n` +
          leaks.map((leak) => `  - ${leak}`).join('\n') +
          `\nThe state is now restored. Restore it in the file's own afterEach or afterAll (AGENTS.md, Unit test cleanup).`,
      );
    }
  });
}

function processListeners(event: string): Listener[] {
  // SAFETY: Node types listeners() as Function[]; every entry is a listener
  // registered with process.on(), which only accepts functions of this shape.
  return process.listeners(event) as Listener[];
}
