import { boundary } from '../validation/boundaryDecoder';

export const CLI_AGENTS = ['claude', 'codex', 'cursor'] as const;
export type CliAgentType = typeof CLI_AGENTS[number];
export const cliAgentSchema = boundary.enumeration(...CLI_AGENTS);
export const CLI_AGENT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
} satisfies Record<CliAgentType, string>;
