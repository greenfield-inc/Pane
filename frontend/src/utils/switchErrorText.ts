/** The longest reason the kept bar shows; a longer one is cut with an ellipsis. */
const MAX_REASON = 200;

/**
 * A short reason for a switch that failed, for the kept bar beside what was typed (QA 1781 note).
 * A host or a proxy in front of it can answer with an empty body, JSON or an HTML error page; that
 * is shown as one plain line instead, as the connection checklist does. A readable reason stays.
 */
export function switchFailureReason(raw: string, machineName: string): string {
  const generic = `${machineName} answered with an error instead of opening. Try again in a moment.`;
  // The IPC wrapper and any error-class prefixes ("Error:", "PaneError:") say nothing to the person.
  let reason = raw.replace(/^Error invoking remote method '[^']*':\s*/, '');
  while (/^\w*Error:\s*/.test(reason)) reason = reason.replace(/^\w*Error:\s*/, '');
  // One line: a body, a page or a stack after the first line is not the reason.
  reason = (reason.split('\n')[0] ?? '').trim();
  // Text before a JSON body or a page ("Host answered 502: {...}") is the reason; the body is not.
  const body = reason.search(/[{[<]/);
  if (body >= 0) reason = reason.slice(0, body).trim().replace(/[:\s]+$/, '');
  if (reason && !/[.!?]$/.test(reason) && body > 0) reason = `${reason}.`;
  if (!reason || /^(null|undefined|\[object \w+\])$/i.test(reason)) return generic;
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1).trimEnd()}…` : reason;
}
