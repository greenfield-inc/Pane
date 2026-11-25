/**
 * The screen to reopen when Android restarts the app's screen in the same process, as a fold
 * that changes density does. The app's JavaScript keeps running through that restart, but the
 * navigator starts again on Home. Kept in memory only: a new process starts on Home.
 */

export interface NavigationState {
  index?: number;
  routes: { name: string; params?: object; state?: NavigationState }[];
}

export interface ScreenToReopen {
  pathname: string;
  params: Record<string, string>;
}

// Routes presented as sheets or modals in `app/_layout.tsx`. A restart loses them; the screen under them reopens.
const SHEETS = new Set([
  'connect', 'open', 'scan', 'pair', 'new', 'sort-approvals', 'machine/connect', 'settings/shortcut', 'hosts/add',
  'notify/[notifyId]', 'pane/[paneId]/permission', 'pane/[paneId]/notify', 'pane/[paneId]/new-panel',
]);
const PANE_PATH = '/pane/[paneId]';

let remembered: { hostId: string; screen: ScreenToReopen; paneId?: string } | null = null;

/** The screen on top of the stack, under any sheet, unless that is Home. */
export function topScreen(root: NavigationState | undefined): ScreenToReopen | null {
  const top = stackRoutes(root).findLast(route => !SHEETS.has(route.name));
  if (!top || top.name === 'index') return null;
  return { pathname: `/${top.name.replace(/\/index$/, '')}`, params: stringParams(top.params) };
}

/** Notes the screen on top for the computer the app is on. Call it on every navigation change. */
export function rememberScreen(hostId: string, root: NavigationState | undefined): void {
  const screen = topScreen(root);
  remembered = screen ? { hostId, screen, ...(screen.pathname === PANE_PATH ? { paneId: screen.params.paneId } : {}) } : null;
}

/** The person is leaving the app: its next start opens on Home. */
export function forgetScreen(): void {
  remembered = null;
}

/** The remembered screen, once, when it is on this computer and its Pane, if any, still exists. */
export function takeScreenToReopen(hostId: string, paneExists: (paneId: string) => boolean): ScreenToReopen | null {
  const saved = remembered;
  remembered = null;
  if (!saved || saved.hostId !== hostId) return null;
  if (saved.paneId !== undefined && !paneExists(saved.paneId)) return null;
  return saved.screen;
}

/** The flat stack's routes: Expo Router's root route holds them. */
function stackRoutes(state: NavigationState | undefined): NavigationState['routes'] {
  if (!state) return [];
  const focused = state.routes[state.index ?? state.routes.length - 1];
  return focused?.state ? stackRoutes(focused.state) : state.routes;
}

function stringParams(params: object | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(params ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
