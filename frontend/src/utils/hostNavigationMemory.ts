import { useConfigStore } from '../stores/configStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { API } from './api';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import type { HostNavigationMemory, PaneNavigationView } from '../../../shared/types/hostNavigation';
import type { Project } from '../types/project';

/**
 * Remembers where the user was on each host so switching away and back lands on
 * the same Session, Pane and repository view instead of the home page. Pane,
 * repository and Session ids are per host, so a memory is only read back for the
 * host it was written under, and every id in it is revalidated before use.
 *
 * Restoring selects *one* Pane, exactly as a click would: it never revives every
 * terminal that was once open on that host.
 */
interface NavigationSnapshot {
  view: PaneNavigationView;
  projectId: number | null;
  paneId: string | null;
}

// Pane switching can be held down on Cmd/Ctrl+Arrow; coalesce the writes.
const WRITE_DEBOUNCE_MS = 250;

let pauseDepth = 0;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let recorded: NavigationSnapshot | null = null;
let shownHostId: string | null | undefined;

/** Reads the three fields that make up a location. Cheap enough for a hot store subscription. */
function currentNavigation(): NavigationSnapshot {
  const { activeView, activeProjectId } = useNavigationStore.getState();
  return {
    view: activeView,
    projectId: activeProjectId,
    paneId: useSessionStore.getState().activeSessionId,
  };
}

function isSameNavigation(left: NavigationSnapshot, right: NavigationSnapshot): boolean {
  return left.view === right.view && left.projectId === right.projectId && left.paneId === right.paneId;
}

function activeHostIdFromConfig(): string | null | undefined {
  const config = useConfigStore.getState().config;
  return config ? getActiveRemoteHostId(config.remoteDaemon) : undefined;
}

/**
 * Names the host whose state is on screen, or undefined before config has loaded
 * — writing then would attribute the location to the wrong host.
 *
 * Deliberately not read from config on every write: config flips to the incoming
 * host the moment a switch starts, while the renderer goes on showing the
 * outgoing host until the resync arrives. Only a resync that loaded a new host's
 * state moves this, so a write in that window still lands on the host it came
 * from.
 */
function hostShowing(): string | null | undefined {
  if (shownHostId === undefined) shownHostId = activeHostIdFromConfig();
  return shownHostId;
}

function cancelPendingWrite(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

async function writeNavigationMemory(hostId: string | null): Promise<void> {
  if (pauseDepth > 0) return;
  const snapshot = currentNavigation();
  if (recorded && isSameNavigation(recorded, snapshot)) return;

  recorded = snapshot;
  const memory: HostNavigationMemory = {
    view: snapshot.view,
    projectId: snapshot.projectId,
    paneId: snapshot.paneId,
  };
  try {
    const response = await window.electronAPI.uiState.saveNavigationMemory(hostId, memory);
    if (!response.success) recorded = null;
  } catch (error) {
    recorded = null;
    console.warn('[hostNavigationMemory] Failed to remember the current location:', error);
  }
}

function scheduleNavigationMemoryWrite(): void {
  if (pauseDepth > 0 || pendingTimer) return;
  const snapshot = currentNavigation();
  if (recorded && isSameNavigation(recorded, snapshot)) return;
  // Pin the host while this location is still the one on screen. Leave
  // `recorded` unset when it is not yet known, so the next change retries.
  const hostId = hostShowing();
  if (hostId === undefined) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    void writeNavigationMemory(hostId);
  }, WRITE_DEBOUNCE_MS);
}

/** Records the active host's location as the user navigates. Call once, from the app shell. */
export function startHostNavigationMemoryWrites(): () => void {
  recorded = null;
  shownHostId = undefined;
  const unsubscribeNavigation = useNavigationStore.subscribe(scheduleNavigationMemoryWrite);
  const unsubscribeSessions = useSessionStore.subscribe(scheduleNavigationMemoryWrite);
  return () => {
    unsubscribeNavigation();
    unsubscribeSessions();
    cancelPendingWrite();
  };
}

/**
 * Holds writes while a host switch rewrites navigation wholesale, so the
 * outgoing host's cleared state is never attributed to the incoming host. The
 * location the switch lands on is recorded once it finishes, which also retires
 * a remembered Pane that has since been archived on that host.
 */
export async function withHostNavigationWritesPaused<T>(run: () => Promise<T>): Promise<T> {
  pauseDepth += 1;
  cancelPendingWrite();
  try {
    return await run();
  } finally {
    pauseDepth -= 1;
    // The switch has settled — even if it failed part way — so config now names
    // the host on screen, and later writes belong to it.
    shownHostId = activeHostIdFromConfig();
    recorded = null;
    scheduleNavigationMemoryWrite();
  }
}

async function projectExists(projectId: number): Promise<boolean> {
  try {
    const response = await API.projects.getAll();
    if (!response.success || !response.data) return false;
    const projects: Project[] = response.data;
    return projects.some(project => project.id === projectId);
  } catch (error) {
    console.warn('[hostNavigationMemory] Failed to verify the remembered repository:', error);
    return false;
  }
}

async function readNavigationMemory(hostId: string | null): Promise<HostNavigationMemory | null> {
  try {
    const response = await window.electronAPI.uiState.getNavigationMemory(hostId);
    return response.success ? response.data ?? null : null;
  } catch (error) {
    console.warn('[hostNavigationMemory] Failed to read the remembered location:', error);
    return null;
  }
}

/**
 * Restores the newly active host's remembered location. Must run after that
 * host's Panes and config have loaded, since every id is validated against them;
 * anything that no longer exists leaves the caller's home view in place.
 */
export async function restoreHostNavigation(): Promise<void> {
  // The resync refetched config before calling this, so it names the incoming
  // host, whose memory is the one to read.
  const hostId = activeHostIdFromConfig();
  if (hostId === undefined) return;

  const memory = await readNavigationMemory(hostId);
  if (!memory) return;

  const navigation = useNavigationStore.getState();
  const { setActiveSession } = useSessionStore.getState();

  if (memory.view === 'project' || memory.view === 'git-graph') {
    // The repository view mounts the project's own main-repo Pane itself.
    if (memory.projectId === null || !(await projectExists(memory.projectId))) return;
    await setActiveSession(null);
    if (memory.view === 'git-graph') navigation.navigateToGitGraph(memory.projectId);
    else navigation.navigateToProject(memory.projectId);
    return;
  }

  if (memory.view === 'pane-chat') {
    // Which Session is selected is the host's own state; the resync adopts it.
    await setActiveSession(null);
    navigation.navigateToPaneChat();
    return;
  }

  navigation.navigateToSessions();
  const remembered = memory.paneId !== null
    && useSessionStore.getState().sessions.some(session => session.id === memory.paneId);
  await setActiveSession(remembered ? memory.paneId : null);
}
