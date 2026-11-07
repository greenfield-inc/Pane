import type { NotifyItem } from '../../../../shared/types/notify';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/** A document linked from an item, read from the machine that holds it. */
export type MachineDoc =
  | { kind: 'text'; text: string }
  | { kind: 'html'; html: string }
  | { kind: 'missing' }
  | { kind: 'unreachable' };

/** A read that has not answered by then has failed: no spinner stays up. */
const READ_TIMEOUT_MS = 10_000;

/**
 * The read every machine already serves the phone: a file its waiting items link, as an
 * `AutopilotDocument`. Asked with `inline`, an html page comes as its text, since its file URL
 * means nothing here.
 */
const READ_DOC_CHANNEL = 'autopilot:read-doc';
type MachineRead = (machineId: string, channel: string, args: unknown[]) => Promise<{ data: unknown }>;

/** The item's file links. */
export function machineFileLinks(item: NotifyItem): Array<{ path: string; label: string }> {
  return (item.links ?? []).flatMap((link) => ('path' in link ? [{ path: link.path, label: link.label }] : []));
}

const textSchema = boundary.object({ kind: boundary.literal('text'), text: boundary.string });
const htmlSchema = boundary.object({ kind: boundary.literal('html'), html: boundary.string });
const missingSchema = boundary.object({ kind: boundary.literal('missing') });

function decodeDoc(answer: Awaited<ReturnType<MachineRead>>['data']): MachineDoc {
  const text = decodeOptionalBoundary(answer, textSchema);
  if (text) return { kind: 'text', text: text.text };
  const page = decodeOptionalBoundary(answer, htmlSchema);
  if (page) return { kind: 'html', html: page.html };
  return decodeOptionalBoundary(answer, missingSchema) ? { kind: 'missing' } : { kind: 'unreachable' };
}

/** Reads a linked file from the item's machine. Never rejects: a failed read is a state. */
export async function readMachineDoc(item: NotifyItem, path: string): Promise<MachineDoc> {
  // SAFETY: main refuses a channel it doesn't serve, and that refusal is a failed read below.
  const read = window.electronAPI.machines.read as MachineRead;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'unreachable' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'unreachable' }), READ_TIMEOUT_MS);
  });
  try {
    const reading = read(item.machineId ?? 'local', READ_DOC_CHANNEL, [path, { inline: true }]).then((result) => decodeDoc(result.data));
    return await Promise.race([reading, timeout]);
  } catch {
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** The one line a document that didn't load shows. */
export function machineDocFailure(doc: MachineDoc, label: string, machine: string): string | undefined {
  if (doc.kind === 'missing') return `${label} isn't on ${machine} anymore`;
  if (doc.kind === 'unreachable') return `Couldn't reach ${machine}`;
  return undefined;
}
