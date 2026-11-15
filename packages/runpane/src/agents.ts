import { RUNPANE_CONTRACT, type RunpaneAgent } from './generated/contract';

/** A configured agent's terminal launch command, from the contract's agents config: executable, full-access flags, then args. */
export function agentTerminalCommand(agent: RunpaneAgent): string {
  const { executables, terminal } = RUNPANE_CONTRACT.agents.entries[agent];
  return [executables[0], ...terminal.fullAccessArgs, ...terminal.args].join(' ');
}

/** The flags that pick a model and reasoning effort for one launch; an effort the CLI has no flag for is left out. */
export function agentModelArgs(agent: RunpaneAgent, choice: { model?: string; effort?: string }): string[] {
  const entry: { models?: { flag: string; effortFlag?: string; effortConfig?: string } } = RUNPANE_CONTRACT.agents.entries[agent];
  const models = entry.models;
  if (!models) return [];
  const args: string[] = [];
  if (choice.model) args.push(models.flag, choice.model);
  if (choice.effort && models.effortFlag) args.push(models.effortFlag, choice.effort);
  else if (choice.effort && models.effortConfig) args.push('-c', `${models.effortConfig}=${choice.effort}`);
  return args;
}
