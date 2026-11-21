import { useEffect, useSyncExternalStore } from 'react';
import type { BrowserPanelState } from '@shared/types/panels';
import { initialStreamChoice, nextStreamTick, streamChoices, type StreamChoiceEvent } from '@shared/utils/streamChoice';

/**
 * Whether this screen streams a tab from its host or shows its own copy (shared/utils/streamChoice.ts):
 * `input` notes the person's input on the stream, `back` returns to the own copy now, `live` streams
 * until Back to my copy. The choice outlives this view, so tab menus see it too.
 */
export function useStreamChoice(panelId: string, state: BrowserPanelState | undefined) {
  const stored = useSyncExternalStore(streamChoices.subscribe, streamChoices.all).get(panelId);
  const agentDriving = state?.driver?.by === 'agent';
  const typed = state?.agentUse === 'typed';
  const dispatch = (event: StreamChoiceEvent) => streamChoices.dispatch(panelId, event, () => initialStreamChoice(agentDriving, typed));
  const choice = stored ?? initialStreamChoice(agentDriving, typed);
  useEffect(() => {
    const initial = () => initialStreamChoice(agentDriving, typed);
    const at = Date.now();
    streamChoices.dispatch(panelId, { kind: 'agent', driving: agentDriving, at }, initial);
    streamChoices.dispatch(panelId, { kind: 'typed', typed, at }, initial);
  }, [panelId, agentDriving, typed]);
  const next = nextStreamTick(choice);
  useEffect(() => {
    if (next === undefined) return;
    const timer = setTimeout(() => streamChoices.dispatch(panelId, { kind: 'tick', at: Date.now() }, () => initialStreamChoice(false)), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [panelId, next]);
  return {
    stream: choice.stream,
    back: () => dispatch({ kind: 'back' }),
    live: () => dispatch({ kind: 'live' }),
    input: () => dispatch({ kind: 'input', at: Date.now() }),
  };
}
