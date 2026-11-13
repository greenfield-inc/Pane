import { RUNPANE_CONTRACT, type RunpaneAgent } from './generated/contract';

/** A configured agent's terminal launch command, from the contract's agents config: executable, full-access flags, then args. */
export function agentTerminalCommand(agent: RunpaneAgent): string {
  const { executables, terminal } = RUNPANE_CONTRACT.agents.entries[agent];
  return [executables[0], ...terminal.fullAccessArgs, ...terminal.args].join(' ');
}
