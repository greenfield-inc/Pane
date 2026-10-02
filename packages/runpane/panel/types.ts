import type { Agent, CardData, PanelData } from './model';

export interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

export interface AgentActions {
  send: (agent: Agent, text: string) => Promise<boolean>;
  open: (agent: Agent) => void;
  openPr: (agent: Agent) => void;
  notices: Record<string, Notice | undefined>;
  busy: Record<string, 'send' | 'open' | undefined>;
}

export interface CardProps {
  data?: CardData;
  failed?: string;
  actions: AgentActions;
}

export interface PanelProps {
  data: PanelData;
  selected?: string;
  onSelect: (paneId: string) => void;
  actions: AgentActions;
}
