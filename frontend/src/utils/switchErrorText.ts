/** The longest reason the kept bar shows; a longer one is cut with an ellipsis. */
const MAX_REASON = 200;

/**
 * A short reason for a switch that failed, for the kept bar beside what was typed (QA 1781 note).
 * A host or a proxy in front of it can answer with an empty body, JSON or an HTML error page; that
 * is shown as one plain line instead, as the connection checklist does. A readable reason stays.
 */
export function switchFailureReason(raw: string, machineName: string): string {
  const reason = raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '').trim();
  const unreadable = reason === '' || /^[{[]/.test(reason) || /<\/?[a-z!][^>]*>/i.test(reason);
  if (unreadable) return `${machineName} answered with an error instead of opening. Try again in a moment.`;
  return reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1).trimEnd()}…` : reason;
}
