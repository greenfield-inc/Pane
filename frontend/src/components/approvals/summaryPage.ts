import type { NotifyItem } from '../../../../shared/types/notify';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/** An approval's Summary page as the column shows it, or why it can't. */
export type SummaryRead =
  | { kind: 'page'; path: string; html: string }
  | { kind: 'template'; html: string }
  | { kind: 'failed'; message: string };

/** A read that has not answered by then has failed: no spinner stays up. */
const READ_TIMEOUT_MS = 10_000;
const SUMMARY_CHANNEL = 'notify:summary-page';
type MachineRead = (machineId: string, channel: string, args: unknown[]) => Promise<{ data: unknown }>;

const pageSchema = boundary.object({ kind: boundary.literal('page'), path: boundary.string, html: boundary.string });
const templateSchema = boundary.object({ kind: boundary.literal('template'), html: boundary.string });
const missingSchema = boundary.object({ kind: boundary.literal('missing'), message: boundary.string });

/** The id the holding machine knows the approval by: a saved machine's card is `<machineId>:<its id>`. */
function hostItemId(item: Pick<NotifyItem, 'id' | 'machineId'>): string {
  const machine = item.machineId;
  return machine && machine !== 'local' && item.id.startsWith(`${machine}:`) ? item.id.slice(machine.length + 1) : item.id;
}

/**
 * Reads the approval's Summary from the machine that holds it (`notify:summary-page`), the same
 * read the phone makes. Never rejects: a failed read is a state with its reason.
 */
export async function readSummaryPage(item: NotifyItem, theme: 'light' | 'dark'): Promise<SummaryRead> {
  // SAFETY: main refuses a channel it doesn't serve, and that refusal is a failed read below.
  const read = window.electronAPI.machines.read as MachineRead;
  const machine = item.machine ?? 'this machine';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SummaryRead>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'failed', message: `Couldn't reach ${machine} for the Summary. Try again once it's online.` }), READ_TIMEOUT_MS);
  });
  try {
    const reading = read(item.machineId ?? 'local', SUMMARY_CHANNEL, [hostItemId(item), { theme }]).then(({ data }): SummaryRead => {
      const page = decodeOptionalBoundary(data, pageSchema);
      if (page) return page;
      const template = decodeOptionalBoundary(data, templateSchema);
      if (template) return template;
      const missing = decodeOptionalBoundary(data, missingSchema);
      return { kind: 'failed', message: missing?.message ?? `${machine} sent no Summary for this approval.` };
    });
    return await Promise.race([reading, timeout]);
  } catch (error) {
    return { kind: 'failed', message: `Couldn't read the Summary from ${machine}: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}
