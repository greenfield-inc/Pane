import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { AlertCircle } from 'lucide-react';
import type { TerminalLaunchExitedEvent } from '../../../../../shared/types/agentStatus';
import { agentPreset } from '../../../../../shared/constants/agentLaunchPresets';
import type { ToolPanel } from '../../../../../shared/types/panels';
import { useAgentReadiness } from '../../../hooks/useAgentReadiness';
import { useSessionStore } from '../../../stores/sessionStore';
import { usePanelStore } from '../../../stores/panelStore';
import { panelApi } from '../../../services/panelApi';
import { Button } from '../../ui/Button';
import { cn } from '../../../utils/cn';
import { agentSetupTerminal, type AgentSetupKind } from './agentSetup';

const CARD_BUTTON = 'h-7 px-3 py-0 text-xs';

interface LaunchExitState {
  byPanel: Record<string, TerminalLaunchExitedEvent>;
}

const useLaunchExitStore = create<LaunchExitState>(() => ({ byPanel: {} }));
let subscribed = false;

/** Listen for main's `terminal:launchExited` once, for every panel, from the first terminal shown. */
function ensureLaunchExitSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  window.electronAPI.events.onTerminalLaunchExited?.(event => {
    useLaunchExitStore.setState(state => ({ byPanel: { ...state.byPanel, [event.panelId]: event } }));
  });
}

function dismiss(panelId: string): void {
  useLaunchExitStore.setState(state => {
    const { [panelId]: _dismissed, ...rest } = state.byPanel;
    return { byPanel: rest };
  });
}

function stoppedTitle(agentTitle: string, elapsedMs: number): string {
  if (elapsedMs < 1_000) return `${agentTitle} stopped in under a second`;
  const seconds = Math.round(elapsedMs / 1_000);
  return seconds === 1 ? `${agentTitle} stopped after 1 second` : `${agentTitle} stopped after ${seconds} seconds`;
}

/** Open a terminal tab beside this one with the agent's install or sign-in command typed. */
async function openSetupTerminal(panel: ToolPanel, agent: TerminalLaunchExitedEvent['agent'], kind: AgentSetupKind): Promise<void> {
  // The card only shows where Pane sees the foreground process: macOS and Linux shells.
  const setup = agentSetupTerminal(agent, kind, undefined);
  if (!setup) return;
  const created = await panelApi.createPanel({ sessionId: panel.sessionId, type: 'terminal', title: setup.title, initialState: setup.initialState });
  const store = usePanelStore.getState();
  store.addPanel(created);
  store.requestActivation({ sessionId: panel.sessionId, panelId: created.id });
}

/**
 * Covers an agent tab whose agent returned to the shell within seconds of
 * launch: why it stopped and the fix, instead of a dead prompt. It sits on
 * the same layer as the terminal's loading mask and never resizes the
 * terminal; "Open terminal" removes it.
 */
export const LaunchExitCard: React.FC<{ panel: ToolPanel; onOpenTerminal: () => void }> = ({ panel, onOpenTerminal }) => {
  useEffect(ensureLaunchExitSubscription, []);
  const exit = useLaunchExitStore(state => state.byPanel[panel.id]);
  const projectId = useSessionStore(state => (
    state.sessions.find(session => session.id === panel.sessionId)
    ?? (state.activeMainRepoSession?.id === panel.sessionId ? state.activeMainRepoSession : undefined)
  )?.projectId);
  const readiness = useAgentReadiness(exit ? projectId : undefined, exit ? [exit.agent] : []);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  if (!exit) return null;
  const title = agentPreset(exit.agent).title;
  const state = readiness[exit.agent];
  const cause: AgentSetupKind | undefined = state === 'signed-out' ? 'sign-in' : state === 'not-installed' ? 'install' : undefined;
  const reason = state === 'signed-out'
    ? `${title} isn't signed in on this computer, so it exited before it could start.`
    : state === 'not-installed'
      ? `${title} isn't installed on this computer.`
      : exit.lastLine ? `It said: "${exit.lastLine}"` : null;

  const tryAgain = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await window.electronAPI.invoke('runpane:panels:resume', { panelId: panel.id });
      dismiss(panel.id);
    } catch (error) {
      setRetryError(`Couldn't start ${title} again: ${error instanceof Error ? error.message : String(error)}. Open the terminal to run it yourself.`);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-surface-primary" data-testid="launch-exit-card">
      <section role="alert" className="mx-auto mt-6 w-[calc(100%-2rem)] max-w-[380px] rounded-xl border border-status-warning bg-surface-primary p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <AlertCircle aria-hidden="true" className="h-4 w-4 flex-shrink-0 text-status-warning" />
          {state === 'not-installed' ? `${title} isn't installed` : stoppedTitle(title, exit.elapsedMs)}
        </h2>
        {reason && <p className="mt-1.5 break-words text-xs leading-5 text-text-secondary">{reason}</p>}
        {retryError && <p className="mt-1.5 text-xs leading-5 text-status-error">{retryError}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {cause && (
            <Button size="sm" className={CARD_BUTTON} onClick={() => void openSetupTerminal(panel, exit.agent, cause)}>
              {cause === 'sign-in' ? `Sign in to ${title}` : `Install ${title}`}
            </Button>
          )}
          <Button size="sm" variant="secondary" className={cn(CARD_BUTTON, 'border border-border-primary')} loading={retrying} onClick={() => void tryAgain()}>Try again</Button>
          <Button size="sm" variant="ghost" className={CARD_BUTTON} onClick={() => { dismiss(panel.id); onOpenTerminal(); }}>Open terminal</Button>
        </div>
      </section>
    </div>
  );
};
