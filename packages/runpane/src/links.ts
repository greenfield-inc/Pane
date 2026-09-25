import type { ParsedArgs } from './commands';

/** Ids that may appear in a pane:// link. Pane's URL handler applies the same rule. */
const LINK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_ID = /^[1-9][0-9]{0,15}$/;

interface LinkTarget {
  kind: 'pane' | 'repo' | 'session';
  id: string;
  panelId?: string;
}

/** `pane://open?pane=<id>[&panel=<id>]`, `pane://open?repo=<id>`, or `pane://open?session=<id>`. */
export function buildPaneLink(target: LinkTarget): string {
  const params = new URLSearchParams({ [target.kind]: target.id });
  if (target.panelId) params.set('panel', target.panelId);
  return `pane://open?${params.toString()}`;
}

export function runLinksCreate(parsed: ParsedArgs): number {
  const target = linkTargetFrom(parsed);
  const url = buildPaneLink(target);
  if (parsed.json) {
    console.log(JSON.stringify({ ok: true, url, target }, null, 2));
  } else {
    console.log(url);
  }
  return 0;
}

function linkTargetFrom(parsed: ParsedArgs): LinkTarget {
  const given = [parsed.paneId && 'pane', parsed.repo && 'repo', parsed.sessionId && 'session'].filter(Boolean);
  if (given.length !== 1) {
    throw new Error('runpane links create needs exactly one of --pane, --repo, or --session.');
  }
  if (parsed.panelId && !parsed.paneId) {
    throw new Error('--panel needs --pane: a panel link opens the panel inside its Pane.');
  }
  if (parsed.repo) {
    if (!REPO_ID.test(parsed.repo)) {
      throw new Error(`--repo must be a numeric repository id. Run \`runpane repos list\` to find it.`);
    }
    return { kind: 'repo', id: parsed.repo };
  }
  const kind = parsed.paneId ? 'pane' : 'session';
  const id = requireId(parsed.paneId ?? parsed.sessionId, kind === 'pane' ? '--pane' : '--session', kind === 'pane' ? 'runpane panes list' : 'runpane sessions list');
  const target: LinkTarget = { kind, id };
  if (parsed.panelId) target.panelId = requireId(parsed.panelId, '--panel', 'runpane panels list');
  return target;
}

function requireId(value: string | undefined, flag: string, lister: string): string {
  if (value === undefined || !LINK_ID.test(value)) {
    throw new Error(`${flag} must be an id (letters, digits, ".", "_", "-"). Run \`${lister}\` to find it.`);
  }
  return value;
}
