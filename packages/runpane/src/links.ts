import type { ParsedArgs } from './commands';

/** Ids that may appear in a pane:// link. Pane's URL handler applies the same rule. */
const LINK_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const REPO_ID = /^[1-9][0-9]{0,15}$/;
/** A repository id, saved name, or `owner/repo` for a start link, as Pane's URL handler accepts it. */
const REPO_SELECTOR = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}){0,2}$/;
const MAX_LINK_PROMPT_LENGTH = 4000;
/** The longest start link Pane opens, after URL encoding. */
const MAX_START_LINK_LENGTH = 16_384;

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

/** A start link: Pane asks the person, then starts the agent on the prompt in a new Pane. */
interface StartLinkTarget {
  kind: 'new';
  id: string;
  prompt: string;
  agent?: string;
}

/**
 * `pane://open?pane=<id>[&panel=<id>]`, `pane://open?repo=<id>`, `pane://open?session=<id>`, or
 * `pane://new?repo=<repo>&prompt=<text>[&agent=<id>]`.
 */
export function buildPaneLink(target: LinkTarget | StartLinkTarget): string {
  if (target.kind === 'new') {
    const params = new URLSearchParams({ repo: target.id, prompt: target.prompt });
    if (target.agent) params.set('agent', target.agent);
    return `pane://new?${params.toString()}`;
  }
  const params = new URLSearchParams({ [target.kind]: target.id });
  if (target.panelId) params.set('panel', target.panelId);
  return `pane://open?${params.toString()}`;
}

export function runLinksCreate(parsed: ParsedArgs): number {
  const target = linkTargetFrom(parsed);
  const url = buildPaneLink(target);
  if (url.length > MAX_START_LINK_LENGTH) {
    throw new Error(`--prompt makes a ${url.length}-character link once encoded; Pane opens links up to ${MAX_START_LINK_LENGTH}. Shorten the prompt.`);
  }
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, url, target }, null, 2));
  } else {
    console.log(url);
  }
  return 0;
}

function linkTargetFrom(parsed: ParsedArgs): LinkTarget | StartLinkTarget {
  if (parsed.initialInput !== undefined) return startLinkTargetFrom(parsed, parsed.initialInput);
  if (parsed.agent) throw new Error('--agent needs --prompt: it names the agent a start link starts.');
  const given = [parsed.paneId && 'pane', parsed.repo && 'repo', parsed.sessionId && 'session'].filter(Boolean);
  if (given.length !== 1) {
    throw new Error('runpane links create needs exactly one of --pane, --repo, or --session.');
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
  if (!parsed.repo || parsed.paneId || parsed.panelId || parsed.sessionId) {
    throw new Error('A start link takes --repo and --prompt (and optionally --agent), not --pane, --panel or --session.');
  }
  if (!REPO_SELECTOR.test(parsed.repo)) {
    throw new Error('--repo must be a repository id, saved name, or owner/repo. Run `runpane repos list` to find it.');
  }
  const text = prompt.trim();
  if (!text) throw new Error('--prompt must not be empty.');
  if ([...text].length > MAX_LINK_PROMPT_LENGTH) throw new Error(`--prompt must be at most ${MAX_LINK_PROMPT_LENGTH} characters for a link.`);
  if ([...text].some(isUnsafeCharacter)) throw new Error('--prompt must not contain control characters (other than tab and newline) or text-direction characters.');
  const target: StartLinkTarget = { kind: 'new', id: parsed.repo, prompt: text };
  if (parsed.agent) target.agent = parsed.agent;
  return target;
}

/** Control characters other than tab and newline, and bidirectional overrides; Pane refuses them in a link's prompt. */
function isUnsafeCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code < 160)
    || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

function requireId(value: string | undefined, flag: string, lister: string): string {
  if (value === undefined || !LINK_ID.test(value)) {
    throw new Error(`${flag} must be an id (letters, digits, ".", "_", "-"). Run \`${lister}\` to find it.`);
  }
  return value;
}
