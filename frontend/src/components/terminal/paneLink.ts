const LINK_ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';
const REPO_ID = '[1-9][0-9]{0,15}';

export const PANE_LINK_REGEX = /pane:\/\/[^\s<>"{}|\\^`[\]]+/gi;

export function parsePaneLink(uri: string): boolean {
  if (uri.length > 2048) return false;
  try {
    const url = new URL(uri);
    if (url.protocol !== 'pane:' || url.hostname !== 'open' || !['', '/'].includes(url.pathname)
      || url.username || url.password || url.port || url.hash) return false;
    const params = new Map<string, string>();
    for (const [key, value] of url.searchParams) {
      if (!['pane', 'panel', 'repo', 'session'].includes(key) || params.has(key)) return false;
      params.set(key, value);
    }
    const targets = ['pane', 'repo', 'session'].filter(key => params.has(key));
    if (targets.length !== 1 || (params.has('panel') && !params.has('pane'))) return false;
    const id = new RegExp(`^${LINK_ID}$`);
    if (params.has('repo')) return new RegExp(`^${REPO_ID}$`).test(params.get('repo') ?? '');
    if (params.has('session')) return id.test(params.get('session') ?? '');
    return id.test(params.get('pane') ?? '') && (!params.has('panel') || id.test(params.get('panel') ?? ''));
  } catch {
    return false;
  }
}
