import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

/** The longest context a worker's card carries; cards clamp it to a few lines with Show more. */
const MAX_CONTEXT = 2_000;

const statusFile = boundary.object({
  summary: boundary.optional(boundary.string),
  step: boundary.optional(boundary.string),
  needs_you: boundary.optional(boundary.nullable(boundary.object({
    why: boundary.optional(boundary.string),
    questions: boundary.optional(boundary.array(boundary.object({ why: boundary.optional(boundary.string) }))),
  }))),
});

function cut(text: string): string {
  if (text.length <= MAX_CONTEXT) return text;
  const head = text.slice(0, MAX_CONTEXT);
  const space = head.lastIndexOf(' ');
  return `${(space > MAX_CONTEXT * 0.8 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** The status file's line for a person, `null` when it has none, or undefined when it isn't JSON. */
function statusLine(text: string): string | null | undefined {
  let json: JsonValue;
  try {
    // SAFETY: JSON.parse yields a JSON value, which the decoder below checks.
    json = JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
  const status = decodeOptionalBoundary(json, statusFile);
  return [status?.needs_you?.questions?.[0]?.why, status?.needs_you?.why, status?.summary, status?.step].map(value => value?.trim()).find(Boolean) ?? null;
}

/**
 * What a worker's question card says the worker was doing, from its report summary. A report
 * sent with `--summary-file` carries the whole status file, often JSON, which already opens
 * beside the card as the worker's status link; from JSON the card shows one human line (the
 * question's why, else the summary or step), or nothing. Prose stays as written, capped.
 */
export function workerReportContext(summary: string | undefined): string | undefined {
  const text = summary?.trim();
  if (!text) return undefined;
  const line = text.startsWith('{') || text.startsWith('[') ? statusLine(text) : undefined;
  if (line === undefined) return cut(text);
  return line ? cut(line) : undefined;
}
