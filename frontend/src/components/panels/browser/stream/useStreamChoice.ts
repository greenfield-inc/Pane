import { useEffect, useReducer } from 'react';
import { initialStreamChoice, nextStreamTick, streamChoice } from '../../../../../../shared/utils/streamChoice';

/**
 * Whether this screen streams a tab from its host (an agent drives it, or anyone gave it input in the last 30 s) or
 * shows its own copy; `input` notes the person's input on the stream, `back` returns to the own copy now (shared/utils/streamChoice.ts).
 */
export function useStreamChoice(agentDriving: boolean) {
  const [state, dispatch] = useReducer(streamChoice, agentDriving, initialStreamChoice);
  useEffect(() => { dispatch({ kind: 'agent', driving: agentDriving, at: Date.now() }); }, [agentDriving]);
  const next = nextStreamTick(state);
  useEffect(() => {
    if (next === undefined) return;
    const timer = window.setTimeout(() => dispatch({ kind: 'tick', at: Date.now() }), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [next]);
  return { stream: state.stream, back: () => dispatch({ kind: 'back' }), input: () => dispatch({ kind: 'input', at: Date.now() }) };
}
