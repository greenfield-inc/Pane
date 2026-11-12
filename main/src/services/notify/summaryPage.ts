import fs from 'fs';
import path from 'path';
import { NOTIFY_SUMMARY_CSP, type NotifyItem, type NotifyLink, type NotifySubQuestion, type NotifySummaryPage } from '../../../../shared/types/notify';
import { boundary, decodeOptionalBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

/**
 * An approval's Summary as one HTML page (P4): the asker's own page when it sent one, otherwise
 * the page Pane writes from the card's fields and, for a worker, its status file. Nothing is
 * stored; the page is read or written each time it's shown. Either way it is served with
 * NOTIFY_SUMMARY_CSP (no scripts, no network), and every viewer also turns scripts off.
 */

/** A Summary page larger than this isn't shown inline; open the file instead. */
const PAGE_LIMIT_BYTES = 4 * 1024 * 1024;

export type SummaryTheme = 'light' | 'dark';

const statusSchema = boundary.object({
  step: boundary.optional(boundary.string),
  state: boundary.optional(boundary.string),
  checks: boundary.optional(boundary.object({
    passed: boundary.optional(boundary.array(boundary.json)),
    failed: boundary.optional(boundary.array(boundary.json)),
    undetermined: boundary.optional(boundary.array(boundary.json)),
  })),
});

function escape(text: string): string {
  return text.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

/** The policy as the page's first element, so it holds before anything else in it loads. */
function withPolicy(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${NOTIFY_SUMMARY_CSP}">`;
  const head = /<head(\s[^>]*)?>/iu.exec(html);
  if (head) return `${html.slice(0, head.index + head[0].length)}${meta}${html.slice(head.index + head[0].length)}`;
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

/** The worker's step and checks, from its status file, when it can be read. */
function whereItStands(statusFile: string | undefined): string | undefined {
  if (!statusFile) return undefined;
  let json: JsonValue;
  try {
    // SAFETY: JSON.parse yields a JSON value, which the decoder checks.
    json = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as JsonValue;
  } catch {
    return undefined;
  }
  const status = decodeOptionalBoundary(json, statusSchema);
  if (!status) return undefined;
  const parts: string[] = [];
  if (status.step?.trim()) parts.push(status.step.trim().replace(/[.;]?$/u, '.'));
  const count = (list: JsonValue[] | undefined) => list?.length ?? 0;
  const { passed, failed, undetermined } = status.checks ?? {};
  const checks = [
    count(passed) ? `${count(passed)} passed` : '',
    count(failed) ? `${count(failed)} failed` : '',
    count(undetermined) ? `${count(undetermined)} undetermined` : '',
  ].filter(Boolean);
  if (checks.length) parts.push(`Checks: ${checks.join(', ')}.`);
  return parts.length ? parts.join(' ') : undefined;
}

function referenceLine(link: NotifyLink): string {
  if ('path' in link) return `<li><strong>${escape(link.label)}</strong>: <code>${escape(link.path)}</code></li>`;
  if ('url' in link) return `<li><strong>${escape(link.label)}</strong>: <code>${escape(link.url)}</code></li>`;
  return `<li><strong>${escape(link.label)}</strong>: approval ${escape(link.approval)}</li>`;
}

function stateLabel(item: NotifyItem): string {
  if (item.state === 'answered') return 'answered';
  if (item.state === 'expired') return 'closed';
  if (item.reply?.state === 'reading') return 'with the agent';
  if (item.reply?.state === 'question') return 'getting more context';
  return 'waiting on you';
}

const PALETTE: Record<SummaryTheme, string> = {
  light: '--bg:#ffffff;--text:#1f2328;--muted:#59636e;--line:#d1d9e0;--tint:#eef6ee;--accent:#1a7f37;--chip:#9a6700;--chipbg:#fff8c5;--code:#f6f8fa',
  dark: '--bg:#0d1117;--text:#e6edf3;--muted:#9198a1;--line:#3d444d;--tint:#12261e;--accent:#3fb950;--chip:#d29922;--chipbg:#2e2a1a;--code:#161b22',
};

/** The page Pane writes when the asker sent none: the card, each option and its consequence, where it stands, references. */
export function summaryTemplate(item: NotifyItem, theme: SummaryTheme = 'light'): string {
  const asked = new Date(item.createdAt);
  const time = `${String(asked.getHours()).padStart(2, '0')}:${String(asked.getMinutes()).padStart(2, '0')}`;
  const qn = /^(Q-\d+)\b/u.exec(item.title)?.[1];
  const meta = [item.source.name, item.source.session?.name ?? (item.connected?.kind === 'session' ? item.connected.name : undefined), qn, `asked ${time}`].filter(Boolean).map(part => escape(String(part))).join(' · ');
  const questions: NotifySubQuestion[] = item.questions ?? (item.choices?.length ? [{ title: item.title, choices: item.choices }] : []);
  const choiceSections = questions.map((question, index) => {
    const heading = questions.length > 1 ? `<h3>${index + 1} · ${escape(question.title)}</h3>` : '';
    const why = question.why ? `<p>${escape(question.why)}</p>` : '';
    const rows = question.choices.map(choice => `<tr${choice.recommended ? ' class="rec"' : ''}><td><strong>${escape(choice.label)}</strong>${choice.recommended ? ' <span title="Recommended">★</span>' : ''}</td><td>${choice.detail ? escape(choice.detail) : '<span class="muted">No consequence was sent.</span>'}</td></tr>`).join('');
    return `${heading}${why}<table><thead><tr><th>Option</th><th>What happens next</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join('');
  const stands = whereItStands(item.statusFile);
  const references = item.links?.length ? `<h2>References</h2><ul>${item.links.map(referenceLine).join('')}</ul>` : '';
  const source = item.statusFile ? 'the approval’s fields and the worker’s status file' : 'the approval’s fields';
  return withPolicy(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(item.title)}</title><style>
:root{${PALETTE[theme]};color-scheme:${theme}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 20px 40px}
h1{font-size:22px;line-height:1.3;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}h3{font-size:15px;margin:20px 0 6px}
.chip{display:inline-block;font-size:12px;font-weight:600;color:var(--chip);background:var(--chipbg);border-radius:6px;padding:1px 8px;vertical-align:middle;margin-left:6px}
.meta,.muted{color:var(--muted)}.meta{font-size:13px;margin:0 0 12px}.lead{font-size:16px;margin:0 0 8px}
table{width:100%;border-collapse:collapse;margin:6px 0 4px}th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:8px;border-bottom:1px solid var(--line);vertical-align:top}tr.rec td{background:var(--tint)}
.stands{border-left:3px solid var(--accent);background:var(--tint);padding:10px 14px;margin:20px 0 0;border-radius:4px}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-all}
ul{padding-left:20px}li{margin:4px 0}footer{margin-top:28px;padding-top:10px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
</style></head><body><main>
<h1>${escape(item.title)}<span class="chip">${stateLabel(item)}</span></h1>
<p class="meta">${meta}</p>
${item.context ? `<p class="lead">${escape(item.context)}</p>` : ''}
${choiceSections ? `<h2>${questions.length > 1 ? 'Your choices' : 'Your choice'}</h2>${choiceSections}` : ''}
${stands ? `<p class="stands"><strong>Where it stands.</strong> ${escape(stands)}</p>` : ''}
${references}
<footer>Written by Pane from ${source} (no Summary was sent).</footer>
</main></body></html>`);
}

/** The asker's own page, read with the policy added, or why it can't be. */
function askerPage(file: string): NotifySummaryPage {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { kind: 'missing', path: file, message: `The Summary page ${path.basename(file)} is gone: there is no file at ${file} any more, so Pane can't show it. Its worktree may have been removed.` };
  }
  if (!stat.isFile()) return { kind: 'missing', path: file, message: `${file} is not a file, so Pane can't show it as the Summary.` };
  if (stat.size > PAGE_LIMIT_BYTES) return { kind: 'missing', path: file, message: `${path.basename(file)} is larger than 4 MiB, too large to show here. Open it from References instead.` };
  return { kind: 'page', path: file, html: withPolicy(fs.readFileSync(file, 'utf8')) };
}

/** The approval's Summary: the asker's page when it sent one, else Pane's template. */
export function summaryPage(item: NotifyItem, theme: SummaryTheme = 'light'): NotifySummaryPage {
  if (item.summaryPage) {
    const page = askerPage(item.summaryPage);
    // A page that's gone falls back to the template, which says so in its footer's place.
    if (page.kind !== 'missing') return page;
    return { kind: 'template', html: summaryTemplate(item, theme).replace('(no Summary was sent)', `(the Summary page it sent, ${escape(path.basename(item.summaryPage))}, is gone)`) };
  }
  return { kind: 'template', html: summaryTemplate(item, theme) };
}
