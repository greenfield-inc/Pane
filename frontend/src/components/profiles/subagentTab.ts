import type { CreatePanelRequest, ToolPanel } from '../../../../shared/types/panels';
import type { ProfileSubagentNode } from '../../../../shared/types/profileEditor';
import { panelApi } from '../../services/panelApi';
import { activatePanel } from '../../services/openFileInEditor';
import { isProfilesEnabled, useConfigStore } from '../../stores/configStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import { remoteFailureKind } from '../../utils/remoteFailure';
import type { Session } from '../../types/session';
import { leaveProfilesFor } from './profilesNavigation';
import { subagentLabel } from './profilePreview';

/**
 * Opening a linked agent in a tab from the profile tree (T-83 P4). A launch or process link carries
 * the command Agent Farm lists for it (`profiles list --json`), with no `--parent`: a person needs
 * no permission (plan §5). The tab runs that command unchanged, so its resume is Agent Farm's
 * standard one, derived from the command (`effectiveCustomResume`). An orchestrator opens its own
 * subagent tabs with `runpane panels create --tool-command "<its link's command>"`, which carries
 * `--parent` (P3).
 */

/** The command a row's tab runs, or undefined when the row has none (an agent that runs inside its parent, `any`, or a link that doesn't resolve). */
export function tabCommand(node: ProfileSubagentNode): string | undefined {
  if (node.mode === 'native' || node.any || node.error) return undefined;
  const command = node.command?.trim();
  return command || undefined;
}

/** The Pane a tab opens in: the one you came to Profiles from, which Esc returns to. */
export function tabPane(paneId: string | null | undefined, sessions: readonly Session[], mainRepo: Session | null): Session | undefined {
  if (!paneId) return undefined;
  const pane = mainRepo?.id === paneId ? mainRepo : sessions.find(session => session.id === paneId);
  return pane && !pane.archived ? pane : undefined;
}

/** The Pane a tab would open in right now, for the action's label. */
export function useTabPane(): Session | undefined {
  const paneId = useNavigationStore(state => state.profilesReturn?.paneId);
  const sessions = useSessionStore(state => state.sessions);
  const mainRepo = useSessionStore(state => state.activeMainRepoSession);
  return tabPane(paneId, sessions, mainRepo);
}

/** The action's tooltip and accessible name. */
export function tabActionLabel(node: ProfileSubagentNode, pane: Session | undefined): string {
  return pane ? `Open ${subagentLabel(node)} in a tab in ${pane.name}` : `Open ${subagentLabel(node)} in a tab`;
}

/** What opening a tab does outside this module: make the tab, leave Profiles for its Pane, bring the tab to the front. */
export interface SubagentTabEffects {
  createPanel: (request: CreatePanelRequest) => Promise<ToolPanel>;
  showPane: (paneId: string) => Promise<void>;
  activatePanel: (paneId: string, panelId: string) => Promise<void>;
  hostGeneration: () => number;
}

const PANE_EFFECTS: SubagentTabEffects = {
  createPanel: request => panelApi.createPanel(request),
  showPane: leaveProfilesFor,
  activatePanel,
  hostGeneration: () => panelApi.hostGeneration(),
};

/**
 * Opens the agent in a new terminal tab of the Pane you came from, then shows that Pane with the
 * tab in front. Resolves with the reason it didn't, for the page's notice, or null once it opened.
 */
export async function openSubagentTab(node: ProfileSubagentNode, effects: SubagentTabEffects = PANE_EFFECTS): Promise<string | null> {
  const label = subagentLabel(node);
  const command = tabCommand(node);
  if (!command) return `${label} runs inside its parent, so it has no tab of its own.`;
  if (!isProfilesEnabled(useConfigStore.getState().config)) return 'Turn on Profiles in Settings › Advanced › Experimental to open agents in tabs.';
  const sessions = useSessionStore.getState();
  const pane = tabPane(useNavigationStore.getState().profilesReturn?.paneId, sessions.sessions, sessions.activeMainRepoSession);
  if (!pane) return `Pane didn’t open ${label}: no Pane is open to put its tab in. Open a Pane, then come back to Profiles and try again.`;
  // A late reply must not undo navigation made while it was pending (F-3): the visit and host it was asked from.
  const visit = useNavigationStore.getState().profilesReturn;
  const generation = effects.hostGeneration();
  let panel: ToolPanel;
  try {
    panel = await effects.createPanel({ sessionId: pane.id, type: 'terminal', title: label, initialState: { customState: { initialCommand: command } } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (remoteFailureKind(reason) === 'unknown') {
      return `Pane couldn’t confirm whether it opened ${label} in ${pane.name}: the host never answered. Check ${pane.name} for a ${label} tab before you try again, so it doesn’t start twice.`;
    }
    return `Pane didn’t open ${label} in ${pane.name}: ${reason.replace(/\.$/, '')}. Nothing was started; try again, or run ${command} in a terminal tab.`;
  }
  // The window has moved to another host: this tab is that old host's, so it isn't added here.
  if (effects.hostGeneration() !== generation) return null;
  usePanelStore.getState().addPanel(panel);
  const navigation = useNavigationStore.getState();
  // You left Profiles, or opened it again from elsewhere, while the host made the tab: it stays where it is.
  if (navigation.activeView !== 'profiles' || navigation.profilesReturn !== visit) return null;
  // SessionView applies a queued tab once this visit's layout has loaded, so a remembered tab can't win over it (F-1).
  usePanelStore.getState().requestActivation({ sessionId: pane.id, panelId: panel.id });
  await effects.showPane(pane.id);
  await effects.activatePanel(pane.id, panel.id).catch(() => undefined);
  return null;
}
