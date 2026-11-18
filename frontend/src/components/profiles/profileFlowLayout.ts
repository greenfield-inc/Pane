import dagre from '@dagrejs/dagre';
import { ASK_NEXT_LABEL, flowEdges } from '../../../../shared/profiles/flowGraph';
import { PROFILE_END, type Profile, type ProfileEdgeChooser, type ProfileRunEntry, type ProfileStep } from '../../../../shared/types/profiles';

/** One box of the drawing: a step, or the end of the run. */
export interface FlowNodeLayout {
  id: string;
  step?: ProfileStep;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One labelled arrow: an outcome, a choice or an ask's next. */
export interface FlowEdgeLayout {
  key: string;
  from: string;
  to: string;
  label: string;
  chooser: ProfileEdgeChooser;
  points: Array<{ x: number; y: number }>;
  labelX: number;
  labelY: number;
  /** An agent outcome: its label carries a sample icon. */
  hasSamples: boolean;
}

export interface FlowLayout {
  nodes: FlowNodeLayout[];
  edges: FlowEdgeLayout[];
  width: number;
  height: number;
}

const CHAR_WIDTH = 7.2;
const MONO_CHAR_WIDTH = 7.8;
const LABEL_HEIGHT = 20;
const END_ID = '__end__';

/** A box's size before layout. */
interface NodeSize {
  width: number;
  height: number;
}

function nodeSize(step: ProfileStep): NodeSize {
  switch (step.kind) {
    case 'agent': return { width: Math.max(150, Math.min(200, 24 + Math.max(step.title.length * 8, step.goal.length * 6))), height: 50 };
    // A titled command draws its command under the title.
    case 'command': return step.title === step.run
      ? { width: Math.max(110, Math.min(220, 24 + step.title.length * MONO_CHAR_WIDTH)), height: 34 }
      : { width: Math.max(150, Math.min(240, 24 + Math.max(step.title.length * CHAR_WIDTH, step.run.length * 6.8))), height: 50 };
    case 'ask': return { width: Math.max(160, Math.min(220, 48 + step.title.length * CHAR_WIDTH)), height: 50 };
  }
}

/** The arrows a profile draws, keyed so the same edge can be lit in an example run. */
function edgeKey(from: string, label: string): string {
  return `${from}\u0000${label}`;
}

/**
 * Lays a profile's flow out top to bottom (dagre), so it fits the page's width: one box per step, one labelled arrow per
 * outcome, choice or next, and an end box when an arrow points to `end`.
 */
export function layoutProfileFlow(profile: Profile): FlowLayout {
  const flow = profile.flow;
  if (!flow) return { nodes: [], edges: [], width: 0, height: 0 };
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 44, edgesep: 12, marginx: 16, marginy: 16 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const step of flow.steps) graph.setNode(step.id, { ...nodeSize(step) });
  const edges = flowEdges(flow);
  if (edges.some((edge) => edge.to === PROFILE_END)) graph.setNode(END_ID, { width: 64, height: 30 });
  for (const edge of edges) {
    const target = edge.to === PROFILE_END ? END_ID : edge.to;
    if (!graph.hasNode(target)) continue;
    graph.setEdge(edge.from, target, { label: edge.label, width: edge.label.length * CHAR_WIDTH + (edge.chooser === 'agent' ? 40 : 18), height: LABEL_HEIGHT, labelpos: 'c' }, edgeKey(edge.from, edge.label));
  }
  dagre.layout(graph);
  const nodes: FlowNodeLayout[] = graph.nodes().map((id) => {
    const node = graph.node(id);
    const step = flow.steps.find((candidate) => candidate.id === id);
    const layout: FlowNodeLayout = { id, x: node.x, y: node.y, width: node.width, height: node.height };
    if (step) layout.step = step;
    return layout;
  });
  const laid: FlowEdgeLayout[] = graph.edges().flatMap((reference) => {
    const edge = edges.find((candidate) => edgeKey(candidate.from, candidate.label) === reference.name);
    const data = graph.edge(reference);
    if (!edge || !data) return [];
    const fromStep = flow.steps.find((step) => step.id === edge.from);
    return [{
      key: edgeKey(edge.from, edge.label),
      from: edge.from,
      to: edge.to,
      label: edge.label,
      chooser: edge.chooser,
      points: data.points ?? [],
      labelX: data.x ?? 0,
      labelY: data.y ?? 0,
      hasSamples: fromStep?.kind === 'agent',
    }];
  });
  const size = graph.graph();
  return { nodes, edges: laid, width: size.width ?? 0, height: size.height ?? 0 };
}

/** The steps and arrows an example run lights. */
export interface LitPath {
  steps: Set<string>;
  edges: Set<string>;
}

export function litPath(entries: readonly ProfileRunEntry[]): LitPath {
  const steps = new Set<string>();
  const edges = new Set<string>();
  for (const entry of entries) {
    steps.add(entry.step);
    if (entry.took) edges.add(edgeKey(entry.step, entry.took));
    else if (entry.answer !== undefined) edges.add(edgeKey(entry.step, ASK_NEXT_LABEL));
  }
  return { steps, edges };
}

export const FLOW_END_ID = END_ID;
