import { PROFILE_END, type ProfileFlow, type ProfileFlowEdge, type ProfileStep } from '../types/profiles';

/** The label of the arrow an ask's `next` draws: the person typed an answer. */
export const ASK_NEXT_LABEL = 'answered';

/** Every edge leaving a step, in file order: outcomes, choices, then an ask's `next`. */
export function stepEdges(step: ProfileStep): ProfileFlowEdge[] {
  switch (step.kind) {
    case 'agent':
      return step.outcomes.map((edge) => ({ from: step.id, to: edge.to, label: edge.name, chooser: 'agent' }));
    case 'command':
      return step.outcomes.map((edge) => ({ from: step.id, to: edge.to, label: edge.name, chooser: 'command' }));
    case 'ask': {
      const edges: ProfileFlowEdge[] = step.choices.map((edge) => ({ from: step.id, to: edge.to, label: edge.name, chooser: 'you' }));
      if (step.next) edges.push({ from: step.id, to: step.next, label: ASK_NEXT_LABEL, chooser: 'you' });
      return edges;
    }
  }
}

/** Every arrow the drawing shows: one per outcome, choice or next. */
export function flowEdges(flow: ProfileFlow): ProfileFlowEdge[] {
  return flow.steps.flatMap(stepEdges);
}

/** A step that ends the run when it finishes: a command with no outcomes. */
export function isTerminalStep(step: ProfileStep): boolean {
  return step.kind === 'command' && step.outcomes.length === 0;
}

/** Step ids reachable from `start`, following every edge. */
export function reachableSteps(flow: ProfileFlow): Set<string> {
  const byId = new Map(flow.steps.map((step) => [step.id, step]));
  const seen = new Set<string>();
  const queue = [flow.start];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || id === PROFILE_END || seen.has(id)) continue;
    const step = byId.get(id);
    if (!step) continue;
    seen.add(id);
    for (const edge of stepEdges(step)) queue.push(edge.to);
  }
  return seen;
}
