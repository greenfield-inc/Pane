import { boundary, decodeOptionalBoundary } from '../validation/boundaryDecoder';
import type { BoundarySchema } from '../validation/boundaryDecoder';

/**
 * Pane's whole navigation model (it has no router). The renderer's `ActiveView`
 * aliases this, because a host's remembered location crosses the IPC boundary
 * and has to be decodable in main.
 */
export const PANE_NAVIGATION_VIEWS = ['sessions', 'project', 'pane-chat', 'mission-control', 'ssh', 'loops', 'notify', 'todos', 'autopilot', 'resources'] as const;

export type PaneNavigationView = (typeof PANE_NAVIGATION_VIEWS)[number];

/**
 * Where the user was on one host. Panes, repositories and Sessions all carry
 * per-host ids, so a memory is only ever meaningful for the host it was saved
 * under, and every id in it still has to be revalidated before it is restored.
 *
 * The tabs and split inside a Pane live in their own per-Pane memory.
 */
export interface HostNavigationMemory {
  view: PaneNavigationView;
  /** Repository view's project id, or null when no repository view was open. */
  projectId: number | null;
  /** Active Pane, or null when the Panes home view was showing. */
  paneId: string | null;
  /** Selected Session on this desktop. Absent in memories saved before it was kept. */
  orchestrationSessionId?: string | null;
  /** The to-do open in the To-dos view (T-18: a row on another machine opens it there). Absent in older memories. */
  todoNumber?: number | null;
}

/** The chat tab a launch reopens: the tab in front in the last Pane this computer showed. */
export interface LaunchChat {
  paneId: string;
  panelId: string;
}

/**
 * The launch chat as the window's first frame draws it (frontend/index.html): its message box
 * sits above the Pane's terminal strip when the Pane has a dock terminal. Only for a Pane that
 * shows one group of tabs; in a split the box's place is the app's to work out.
 */
export interface LaunchChatOutline {
  panelId: string;
  dockTerminal: boolean;
}

/** The outline travels in the window's start arguments, like the appearance snapshot, so it is there before the first paint. */
const LAUNCH_CHAT_ARG_PREFIX = '--pane-launch-chat=';

export function encodeLaunchChatArg(outline: LaunchChatOutline): string {
  return `${LAUNCH_CHAT_ARG_PREFIX}${outline.panelId}${outline.dockTerminal ? ',dock' : ''}`;
}

export function decodeLaunchChatArg(argv: readonly string[]): LaunchChatOutline | undefined {
  const value = argv.find(argument => argument.startsWith(LAUNCH_CHAT_ARG_PREFIX))?.slice(LAUNCH_CHAT_ARG_PREFIX.length);
  const [panelId, flag] = value?.split(',') ?? [];
  return panelId ? { panelId, dockTerminal: flag === 'dock' } : undefined;
}

const hostNavigationMemorySchema: BoundarySchema<HostNavigationMemory> = boundary.object({
  view: boundary.enumeration(...PANE_NAVIGATION_VIEWS),
  projectId: boundary.nullable(boundary.number),
  paneId: boundary.nullable(boundary.string),
  orchestrationSessionId: boundary.optional(boundary.nullable(boundary.string)),
  todoNumber: boundary.optional(boundary.nullable(boundary.number)),
});

/** Returns null for anything that is not a usable memory, including older shapes. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- External saved data is decoded immediately with hostNavigationMemorySchema.
export function decodeHostNavigationMemory(value: unknown): HostNavigationMemory | null {
  return decodeOptionalBoundary(value, hostNavigationMemorySchema) ?? null;
}
