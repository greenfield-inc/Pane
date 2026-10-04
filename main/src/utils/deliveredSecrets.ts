import { inspect } from 'util';

/**
 * Values Pane has delivered into an agent's environment (Pane Vault). Pane's
 * log file and its stdout and stderr pass through `redactDeliveredSecrets`, so
 * a delivered value never reaches Pane's own logs, whatever path logged it.
 *
 * What the agent itself prints to its terminal is outside this guarantee.
 */

// Shorter values would redact ordinary log text; register Vault values only.
const MIN_SECRET_LENGTH = 8;
const REDACTED = '[redacted]';

// Longest first, so a value that contains another is replaced whole.
let deliveredValues: string[] = [];

// A logged value may arrive JSON- or inspect-escaped, and inspect splits a
// multi-line string into one literal per line.
function loggedForms(value: string): string[] {
  return [value, ...value.split('\n')].flatMap((text) => [
    text,
    JSON.stringify(text).slice(1, -1),
    inspect(text).slice(1, -1),
  ]);
}

export function registerDeliveredSecrets(values: Iterable<string>): void {
  const merged = new Set(deliveredValues);
  for (const value of values) {
    for (const form of loggedForms(value)) {
      if (form.length >= MIN_SECRET_LENGTH) merged.add(form);
    }
  }
  deliveredValues = [...merged].sort((a, b) => b.length - a.length);
}

export function redactDeliveredSecrets(text: string): string {
  let redacted = text;
  for (const value of deliveredValues) {
    if (redacted.includes(value)) redacted = redacted.split(value).join(REDACTED);
  }
  return redacted;
}

/** Redacts everything this process writes to stdout and stderr, console included. */
export function redactProcessOutput(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    // SAFETY: the wrapper forwards every argument to the stream's own write, replacing only the chunk.
    stream.write = ((...args: Parameters<typeof write>) => {
      if (deliveredValues.length > 0) {
        const [chunk] = args;
        args[0] = redactDeliveredSecrets(chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : chunk);
      }
      return write(...args);
    }) as typeof stream.write;
  }
}
