import { memo } from 'react';
import type { GitGraphRow } from '../../../../shared/types/gitGraph';
import { LANE_WIDTH, ROW_HEIGHT, laneColor } from './graphColors';

const DOT_RADIUS = 4;
/** Length of the cap drawn above a branch tip's dot. */
const TIP_CAP = 5;

/**
 * Path for one edge within a row's band.
 *
 * Every row draws its own slice, so an edge has to cover exactly the part of
 * the band it owns: a pass-through spans the full height, a straight or merge
 * edge leaves the dot half-way down, and a join arrives at the dot from above.
 * Getting this wrong is what turned continuing branches into dashed lines.
 */
function edgePath(kind: string, x1: number, x2: number, centerY: number, rowHeight: number): string {
  switch (kind) {
    case 'passthrough':
      return `M ${x1} 0 L ${x2} ${rowHeight}`;
    case 'straight':
      return `M ${x1} ${centerY} L ${x2} ${rowHeight}`;
    case 'join':
      // Mirror of the merge curve: comes down its own lane, then bends in.
      return `M ${x1} 0 C ${x1} ${centerY * 0.5}, ${x2} ${centerY * 0.75}, ${x2} ${centerY}`;
    default:
      return `M ${x1} ${centerY} C ${x1} ${centerY + rowHeight * 0.35}, ${x2} ${centerY + rowHeight * 0.25}, ${x2} ${rowHeight}`;
  }
}

interface GitGraphCanvasProps {
  row: GitGraphRow;
  laneCount: number;
  /** Highlights the dot when this commit is selected in the list. */
  isSelected: boolean;
}

/**
 * Draws one row's slice of the commit graph: the commit dot plus every edge
 * descending from this row into the next.
 *
 * Purely decorative — `aria-hidden`, zero interactivity. The clickable target
 * is the row button in {@link GitGraphView}, which keeps the graph free of
 * `jsx-a11y/no-static-element-interactions` violations.
 */
export const GitGraphCanvas = memo(function GitGraphCanvas({ row, laneCount, isSelected }: GitGraphCanvasProps) {
  const width = Math.max(laneCount, 1) * LANE_WIDTH;
  const centerY = ROW_HEIGHT / 2;
  const laneX = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
  const isMerge = row.node.parents.length > 1;

  return (
    <svg
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      className="flex-shrink-0"
      aria-hidden="true"
      focusable="false"
    >
      {row.edges.map((edge, index) => (
        <path
          key={`${edge.fromLane}-${edge.toLane}-${edge.kind}-${index}`}
          d={edgePath(edge.kind, laneX(edge.fromLane), laneX(edge.toLane), centerY, ROW_HEIGHT)}
          fill="none"
          stroke={laneColor(edge.colorIndex)}
          strokeWidth={1.5}
          strokeLinecap="round"
          opacity={edge.danglesBelow ? 0.35 : 0.85}
        />
      ))}

      {/*
        Above the dot: the continuation of this lane from the row above, or —
        when the branch starts here — a short rounded cap that reads as a
        beginning instead of a line arriving from nowhere.
      */}
      <path
        d={row.isBranchTip
          ? `M ${laneX(row.lane)} ${centerY - TIP_CAP} L ${laneX(row.lane)} ${centerY}`
          : `M ${laneX(row.lane)} 0 L ${laneX(row.lane)} ${centerY}`}
        fill="none"
        stroke={laneColor(row.colorIndex)}
        strokeWidth={1.5}
        strokeLinecap="round"
        opacity={0.85}
      />

      {/*
        A merge is drawn hollow — the standard cue, and the only thing that
        tells two histories joining here apart from an ordinary commit.
      */}
      <circle
        cx={laneX(row.lane)}
        cy={centerY}
        r={isSelected ? DOT_RADIUS + 1.5 : DOT_RADIUS}
        fill={isMerge ? 'var(--color-bg-primary, #101014)' : laneColor(row.colorIndex)}
        stroke={isMerge ? laneColor(row.colorIndex) : 'var(--color-bg-primary, #101014)'}
        strokeWidth={isMerge ? 2 : 1.5}
      />
    </svg>
  );
});
