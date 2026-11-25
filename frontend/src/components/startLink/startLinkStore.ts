import { create } from 'zustand';
import type { ConfiguredAgentId } from '../../../../shared/agents';
import type { StartLinkRequest } from '../../../../shared/types/startLinks';

/** The person's answer to the shown request: Cancel, or Start with the agent and target they chose. */
export type StartLinkChoice = { start: false } | { start: true; agent: ConfiguredAgentId; target: number };

interface StartLinkState {
  /** The `pane://new` link waiting for Cancel or Start, or null. */
  request: StartLinkRequest | null;
  /** Answers the shown request once; later calls for it do nothing. */
  answer: (choice: StartLinkChoice) => void;
}

function send(requestId: string, choice: StartLinkChoice): void {
  // Main counts a lost answer as Cancel, so a failed send leaves nothing to undo here.
  void window.electronAPI.window.answerStartLink({ requestId, ...choice }).catch(() => undefined);
}

export const useStartLinkStore = create<StartLinkState>((set, get) => ({
  request: null,
  answer: (choice) => {
    const { request } = get();
    if (!request) return;
    set({ request: null });
    send(request.requestId, choice);
  },
}));

/** Shows each start link main asks about. A newer request answers the shown one Cancel first. Returns the unsubscribe. */
export function startStartLinkListener(): () => void {
  const show = (request: StartLinkRequest) => {
    const shown = useStartLinkStore.getState().request;
    if (shown?.requestId === request.requestId) return;
    if (shown) send(shown.requestId, { start: false });
    useStartLinkStore.setState({ request });
  };
  const unsubscribe = window.electronAPI.events.onStartLinkRequest(show);
  // A link that arrived before this listener (the window was still loading) is waiting in main.
  void window.electronAPI.window.pendingStartLink().then((request) => {
    if (request) show(request);
  }, () => undefined);
  return unsubscribe;
}
