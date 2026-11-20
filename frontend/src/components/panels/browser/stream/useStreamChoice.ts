import { useEffect, useReducer } from 'react';
import { initialStreamChoice, nextStreamTick, streamChoice } from '../../../../../../shared/utils/streamChoice';

/**
 * Whether this screen streams a tab from its host (an agent acts on it, or did in the last 30 s) or
 * shows its own copy; `back` returns to the own copy now (shared/utils/streamChoice.ts).
 */
export function useStreamChoice(driving: boolean) {
  const [state, dispatch] = useReducer(streamChoice, driving, initialStreamChoice);
  useEffect(() => { dispatch({ kind: 'driver', driving, at: Date.now() }); }, [driving]);
  const next = nextStreamTick(state);
  useEffect(() => {
    if (next === undefined) return;
    const timer = window.setTimeout(() => dispatch({ kind: 'tick', at: Date.now() }), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [next]);
  return { stream: state.stream, driving: state.driving, back: () => dispatch({ kind: 'back' }) };
}
