import React from 'react';
import { usePanelAgentDisplayStatus } from '../../hooks/useAgentStatus';
import { AgentActivityDot, AgentStatusDot, PausedGlyph } from '../ui/AgentStatusDot';

interface PanelTabStatusDotProps {
  panelId: string;
  sessionId: string;
  paused?: boolean;
}

/**
 * Per-tab status dot: the agent status (blocked / working / done / idle) for
 * any terminal panel — bespoke detection for known agents, the generic tier
 * otherwise. `unknown` only occurs before the first status emission, so it
 * renders an inert placeholder that just holds the dot's footprint.
 */
export const PanelTabStatusDot: React.FC<PanelTabStatusDotProps> = ({ panelId, sessionId, paused }) => {
  const displayStatus = usePanelAgentDisplayStatus(panelId, sessionId);

  if (paused) return <PausedGlyph size="sm" className="flex-shrink-0" />;

  if (displayStatus === 'unknown') {
    return <AgentActivityDot active={false} size="sm" className="flex-shrink-0" />;
  }

  return <AgentStatusDot status={displayStatus} size="sm" className="flex-shrink-0" />;
};
