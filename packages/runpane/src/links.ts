import type { ParsedArgs } from './commands';
import { RUNPANE_CONTRACT } from './generated/contract';

/** Ids that may appear in a pane:// link. Pane's URL handler applies the same rule. */
const LINK_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const REPO_ID = /^[1-9][0-9]{0,15}$/;
/** A repository id, saved name, or `owner/repo` for a start link, as Pane's URL handler accepts it. */
const REPO_SELECTOR = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}){0,2}$/;
// The start-link rules and builders below are copies of shared/startLinks.ts, which packages can't import.
const MAX_LINK_PROMPT_LENGTH = 4_000;
/** The longest start link Pane opens, after URL encoding. */
const MAX_START_LINK_LENGTH = 16_384;
/** Chrome and Edge hand an app at most this many characters of a link from a web page. */
const MAX_WEB_LINK_LENGTH = 2_048;
/** The page that opens a start link, or offers Pane's download when it isn't installed. */
const START_LINK_WEB_BASE = 'https://runpane.com/open';
/** A Session's id or name in a start link: printable, one line, at most 100 characters. Pane's URL handler applies the same rule. */
const MAX_SESSION_SELECTOR_LENGTH = 100;
const UNPRINTABLE_CHARACTER = /[\p{C}\p{Zl}\p{Zp}]/u;

/** A numeric repository id, as app channels and repo links take it. */
export function parseRepoId(repo: string): number {
  if (!REPO_ID.test(repo)) throw new Error('--repo must be a numeric repository id. Run `runpane repos list` to find it.');
  return Number(repo);
}

interface LinkTarget {
  kind: 'pane' | 'repo' | 'session';
  id: string;
  panelId?: string;
}

/** A start link: Pane asks the person, then starts the agent on the prompt in a new Session, a new Pane, or an existing Session. */
interface StartLinkTarget {
  kind: 'new';
  /** The repository selector, as v2.4.255 printed it; kept beside `repo` for callers that read it. */
  id?: string;
  prompt: string;
  agent?: string;
  repo?: string;
  session?: string;
}

/** `pane://open?pane=<id>[&panel=<id>]`, `pane://open?repo=<id>`, or `pane://open?session=<id>`. */
export function buildPaneLink(target: LinkTarget): string {
  const params = new URLSearchParams({ [target.kind]: target.id });
  if (target.panelId) params.set('panel', target.panelId);
  return `pane://open?${params.toString()}`;
}

/** The query both start-link forms share, in a readable order: agent, where, prompt. */
function startLinkQuery({ prompt, agent, repo, session }: StartLinkTarget): string {
  const params = new URLSearchParams();
  if (agent) params.set('agent', agent);
  if (repo) params.set('repo', repo);
  if (session) params.set('session', session);
  params.set('prompt', prompt);
  return params.toString();
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function runLinksCreate(parsed: ParsedArgs): number {
  if (parsed.initialInput !== undefined) return printStartLink(parsed, startLinkTargetFrom(parsed, parsed.initialInput));
  if (parsed.web) throw new Error('--web needs --prompt: runpane.com/open opens start links only.');
  const target = linkTargetFrom(parsed);
  const url = buildPaneLink(target);
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, url, target }, null, 2));
  } else {
    console.log(url);
  }
  return 0;
}

function printStartLink(parsed: ParsedArgs, target: StartLinkTarget): number {
  const query = startLinkQuery(target);
  const url = `pane://new?${query}`;
  const webUrl = `${START_LINK_WEB_BASE}?${query}`;
  if (url.length > MAX_START_LINK_LENGTH) {
    throw new Error(`--prompt makes a ${url.length}-character link once encoded; Pane opens links up to ${MAX_START_LINK_LENGTH}. Shorten the prompt.`);
  }
  if (parsed.web && webUrl.length > MAX_WEB_LINK_LENGTH) {
    throw new Error(`--prompt makes a ${webUrl.length}-character web link once encoded; Chrome and Edge open links up to ${MAX_WEB_LINK_LENGTH} from a web page. Shorten the prompt.`);
  }
  if (parsed.json) {
    const label = parsed.agent ? `Open in Pane with ${RUNPANE_CONTRACT.agents.entries[parsed.agent].label}` : 'Open in Pane';
    const html = `<a href="${escapeHtml(webUrl)}">${escapeHtml(label)}</a>`;
    console.log(JSON.stringify({ ok: true, url, webUrl, html, target }, null, 2));
  } else {
    console.log(parsed.web ? webUrl : url);
  }
  return 0;
}

function linkTargetFrom(parsed: ParsedArgs): LinkTarget {
  if (parsed.agent) throw new Error('--agent needs --prompt: it names the agent a start link starts.');
  const given = [parsed.paneId && 'pane', parsed.repo && 'repo', parsed.sessionId && 'session'].filter(Boolean);
  if (given.length !== 1) {
    throw new Error('runpane links create needs exactly one of --pane, --repo, or --session, or a --prompt.');
  }
  if (parsed.panelId && !parsed.paneId) {
    throw new Error('--panel needs --pane: a panel link opens the panel inside its Pane.');
  }
  if (parsed.repo) {
    return { kind: 'repo', id: String(parseRepoId(parsed.repo)) };
  }
  const kind = parsed.paneId ? 'pane' : 'session';
  const id = requireId(parsed.paneId ?? parsed.sessionId, kind === 'pane' ? '--pane' : '--session', kind === 'pane' ? 'runpane panes list' : 'runpane sessions list');
  const target: LinkTarget = { kind, id };
  if (parsed.panelId) target.panelId = requireId(parsed.panelId, '--panel', 'runpane panels list');
  return target;
}

function startLinkTargetFrom(parsed: ParsedArgs, prompt: string): StartLinkTarget {
  if (parsed.paneId || parsed.panelId) {
    throw new Error('A start link takes --prompt with --agent, --repo or --session, not --pane or --panel.');
  }
  if (parsed.repo && parsed.sessionId) {
    throw new Error('Give --repo or --session, not both: a start link runs in a new Pane in a repository, or in an existing Session.');
  }
  if (parsed.agent && parsed.sessionId) {
    throw new Error("--agent does not apply with --session: the prompt goes to that Session's own agent.");
  }
  if (parsed.repo && !REPO_SELECTOR.test(parsed.repo)) {
    throw new Error('--repo must be a repository id, saved name, or owner/repo. Run `runpane repos list` to find it.');
  }
  const session = parsed.sessionId?.trim();
  if (parsed.sessionId !== undefined && (UNPRINTABLE_CHARACTER.test(parsed.sessionId) || !session || [...session].length > MAX_SESSION_SELECTOR_LENGTH)) {
    throw new Error(`--session must be a Session id or name of at most ${MAX_SESSION_SELECTOR_LENGTH} characters on one line, with no control or invisible characters. Run \`runpane sessions list\` to find it.`);
  }
  if (UNSAFE_CHARACTER.test(prompt)) {
    throw new Error('--prompt must not contain control characters (other than tab and newline), or text-direction or invisible characters.');
  }
  const text = collapsePadding(prompt);
  if (!text) throw new Error('--prompt must not be empty.');
  if ([...text].length > MAX_LINK_PROMPT_LENGTH) throw new Error(`--prompt must be at most ${MAX_LINK_PROMPT_LENGTH} characters for a link.`);
  if (text.startsWith('-')) throw new Error('--prompt must not start with "-", which an agent would read as an option.');
  const target: StartLinkTarget = parsed.repo ? { kind: 'new', id: parsed.repo, prompt: text } : { kind: 'new', prompt: text };
  if (parsed.agent) target.agent = parsed.agent;
  if (parsed.repo) target.repo = parsed.repo;
  if (session) target.session = session;
  return target;
}

/**
 * Characters Pane refuses in a link's prompt: controls other than tab and newline, format
 * characters, line and paragraph separators, and other default-ignorable characters, except one
 * U+FE0E or U+FE0F right after a visible character (an emoji's variation selector).
 */
const UNSAFE_CHARACTER = /[^\t\n\P{Cc}]|[\p{Cf}\p{Zl}\p{Zp}]|[^\P{Default_Ignorable_Code_Point}︎️]|(?:^|[\s︎️])[︎️]/u;

/** The prompt as Pane shows and sends it: trailing spaces and runs of blank lines removed. */
function collapsePadding(text: string): string {
  return text.split('\n').map((line) => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function requireId(value: string | undefined, flag: string, lister: string): string {
  if (value === undefined || !LINK_ID.test(value)) {
    throw new Error(`${flag} must be an id (letters, digits, ".", "_", "-"). Run \`${lister}\` to find it.`);
  }
  return value;
}
