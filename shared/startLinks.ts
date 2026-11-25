/**
 * `pane://new` start links: the rules a prompt must meet, and the link built from it. Pane's URL
 * handler and its link builder use these; the runpane CLIs keep identical copies.
 */

export const MAX_LINK_PROMPT_LENGTH = 4_000;
/** The longest start link Pane opens, after URL encoding. */
export const MAX_START_LINK_LENGTH = 16_384;
/** Chrome and Edge hand an app at most this many characters of a link from a web page. */
export const MAX_WEB_LINK_LENGTH = 2_048;
/** The page that opens a start link, or offers Pane's download when it isn't installed. */
export const START_LINK_WEB_BASE = 'https://runpane.com/open';

/**
 * Characters a confirmation can't show but an agent reads: controls other than tab and newline,
 * format characters (direction marks, zero-width and tag characters, the byte-order mark), line or
 * paragraph separators, and other default-ignorable characters (variation selectors, fillers). An
 * emoji's own text or emoji variation selector (U+FE0E, U+FE0F) is kept, one right after a visible
 * character: a run of them, as hidden-text encodings use, is refused.
 */
const UNSAFE_CHARACTER = /[^\t\n\P{Cc}]|[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Default_Ignorable_Code_Point}︎️]|(?:^|[\s︎️])[︎️]/u;

/** The prompt as Pane shows and sends it (trailing spaces and runs of blank lines removed), or why Pane refuses it. */
export function normalizeLinkPrompt(raw: string): { prompt: string } | { problem: string } {
  if (UNSAFE_CHARACTER.test(raw)) {
    return { problem: 'The prompt holds control, text-direction or invisible characters, which Pane does not send to an agent.' };
  }
  const prompt = raw.split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!prompt) return { problem: 'The prompt is empty.' };
  if ([...prompt].length > MAX_LINK_PROMPT_LENGTH) return { problem: `The prompt is longer than ${MAX_LINK_PROMPT_LENGTH} characters.` };
  if (prompt.startsWith('-')) return { problem: 'The prompt starts with "-", which an agent would read as an option.' };
  return { prompt };
}

export interface StartLinkParts {
  prompt: string;
  agent?: string;
  repo?: string;
  session?: string;
}

/** The query both link forms share, in a readable order: agent, where, prompt. */
function startLinkQuery({ prompt, agent, repo, session }: StartLinkParts): string {
  const params = new URLSearchParams();
  if (agent) params.set('agent', agent);
  if (repo) params.set('repo', repo);
  if (session) params.set('session', session);
  params.set('prompt', prompt);
  return params.toString();
}

/** `pane://new?…`, which Pane opens directly. */
export function buildStartLink(parts: StartLinkParts): string {
  return `pane://new?${startLinkQuery(parts)}`;
}

/** `https://runpane.com/open?…`, for web pages: it opens Pane, or offers the download. */
export function buildWebStartLink(parts: StartLinkParts): string {
  return `${START_LINK_WEB_BASE}?${startLinkQuery(parts)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** One line of HTML for a docs page: a link styled by the page, labelled for the agent. */
export function startLinkButtonHtml(parts: StartLinkParts, agentLabel?: string): string {
  const label = agentLabel ? `Open in Pane with ${agentLabel}` : 'Open in Pane';
  return `<a href="${escapeHtml(buildWebStartLink(parts))}">${escapeHtml(label)}</a>`;
}
