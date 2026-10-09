import { RUNPANE_CONTRACT } from './generated/contract';
import type { ParsedArgs } from './commands';
import { readWorkspaceSummary, type WorkspaceSummary } from './workspace';

type AgentContextCommand =
  typeof RUNPANE_CONTRACT.agentContext.commands[keyof typeof RUNPANE_CONTRACT.agentContext.commands];

interface AgentContextBriefResult {
  ok: true;
  mode: 'brief';
  source: 'runpane-contract';
  summary: string;
  rules: readonly string[];
  tools: typeof RUNPANE_CONTRACT.agentContext.brief.tools;
  detailCommand: string;
  workspaces: WorkspaceSummary;
}

interface AgentContextCommandResult {
  ok: true;
  mode: 'command';
  source: 'runpane-contract';
  command: AgentContextCommand;
}

type AgentContextResult = AgentContextBriefResult | AgentContextCommandResult;

interface AgentContextUnknownCommandError {
  ok: false;
  code: 'unknown_command';
  message: string;
  candidates: string[];
}

const MAX_COMMAND_CANDIDATES = 5;

export async function runAgentContext(parsed: Pick<ParsedArgs, 'contextCommand' | 'json' | 'paneDir'>): Promise<number> {
  if (parsed.contextCommand !== undefined && !findCommandDetail(parsed.contextCommand)) {
    return printUnknownCommand(parsed.contextCommand, parsed.json);
  }
  const result = await buildAgentContextResult(parsed.contextCommand, parsed.paneDir);
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  console.log(result.mode === 'brief'
    ? renderBrief(result)
    : renderCommandDetail(result.command));
  return 0;
}

async function buildAgentContextResult(commandName?: string, paneDir?: string): Promise<AgentContextResult> {
  if (commandName) {
    return {
      ok: true,
      mode: 'command',
      source: 'runpane-contract',
      command: getCommandDetail(commandName)
    };
  }

  const brief = RUNPANE_CONTRACT.agentContext.brief;
  return {
    ok: true,
    mode: 'brief',
    source: 'runpane-contract',
    summary: brief.summary,
    rules: brief.rules,
    tools: brief.tools,
    detailCommand: brief.detailCommand,
    workspaces: await readWorkspaceSummary(paneDir)
  };
}

function findCommandDetail(commandName: string): AgentContextCommand | undefined {
  const normalized = normalizeCommandName(commandName);
  return Object.values(RUNPANE_CONTRACT.agentContext.commands)
    .find((command) => normalizeCommandName(command.name) === normalized);
}

function getCommandDetail(commandName: string): AgentContextCommand {
  const detail = findCommandDetail(commandName);
  if (detail) {
    return detail;
  }

  throw new Error(`Unknown runpane command: ${commandName}. Expected one of: ${commandNames().join(', ')}`);
}

function printUnknownCommand(commandName: string, json: boolean): number {
  const error: AgentContextUnknownCommandError = {
    ok: false,
    code: 'unknown_command',
    message: `Unknown runpane command: ${commandName}. Run \`runpane agent-context --json\` to list every command.`,
    candidates: rankCommandCandidates(commandName),
  };
  if (json) {
    console.log(JSON.stringify(error, null, 2));
  } else {
    console.error(error.message);
    if (error.candidates.length > 0) {
      console.error(`Closest commands: ${error.candidates.join(', ')}`);
    }
  }
  return 2;
}

/**
 * Command names closest to `query`: most shared words first, then smallest edit distance
 * between the names with separators removed, then alphabetical. Far matches are left out.
 */
function rankCommandCandidates(query: string, names: readonly string[] = commandNames()): string[] {
  const queryWords = new Set(commandWords(query));
  const queryCompact = commandWords(query).join('');
  return names
    .map((name) => {
      const words = commandWords(name);
      const compact = words.join('');
      return {
        name,
        shared: new Set(words.filter((word) => queryWords.has(word))).size,
        distance: editDistance(queryCompact, compact),
        maxDistance: Math.max(2, Math.floor(compact.length / 3)),
      };
    })
    .filter((candidate) => candidate.shared > 0 || candidate.distance <= candidate.maxDistance)
    .sort((left, right) => right.shared - left.shared
      || left.distance - right.distance
      || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .slice(0, MAX_COMMAND_CANDIDATES)
    .map((candidate) => candidate.name);
}

function commandWords(commandName: string): string[] {
  return commandName
    .trim()
    .replace(/^runpane\s+/i, '')
    .toLowerCase()
    .split(/[._\s-]+/)
    .filter(Boolean);
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(Math.min(previous[column] + 1, current[column - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length];
}

function normalizeCommandName(commandName: string): string {
  return commandName
    .trim()
    .replace(/^runpane\s+/i, '')
    .toLowerCase()
    .replace(/[._\s-]+/g, '');
}

function renderBrief(result: AgentContextBriefResult): string {
  const lines = [
    RUNPANE_CONTRACT.agentContext.brief.title,
    '',
    result.summary,
    '',
    ...result.workspaces.lines,
    '',
    'Rules:',
    ...result.rules.map((rule) => `- ${rule}`),
    '',
    'Tools:',
    ...result.tools.map((tool) => `- ${tool.name}: ${tool.summary}\n  Args: ${tool.arguments.join(', ')}`),
    '',
    `Detailed definitions: ${result.detailCommand}`
  ];

  return lines.join('\n');
}

function renderCommandDetail(command: AgentContextCommand): string {
  const lines = [
    `runpane ${command.name}`,
    '',
    command.summary,
    '',
    'Details:',
    command.details,
    '',
    `Requires Pane daemon: ${command.requiresPaneDaemon ? 'yes' : 'no'}`,
    `Mutates Pane state: ${command.mutates ? 'yes' : 'no'}`,
    '',
    'Arguments:'
  ];

  if (command.arguments.length === 0) {
    lines.push('- none');
  } else {
    lines.push(...command.arguments.map((argument) => {
      const value = 'value' in argument && argument.value ? ` ${argument.value}` : '';
      const required = argument.required ? 'required' : 'optional';
      return `- ${argument.name}${value} (${required}): ${argument.description}`;
    }));
  }

  lines.push('', 'Examples:', ...command.examples.map((example) => `- ${example}`));

  const jsonSchemas = 'jsonSchemas' in command ? command.jsonSchemas : undefined;
  if (jsonSchemas?.length) {
    lines.push('', 'JSON schemas:', ...jsonSchemas.map((schema: string) => `- ${schema}`));
  }

  if (command.notes?.length) {
    lines.push('', 'Notes:', ...command.notes.map((note) => `- ${note}`));
  }

  return lines.join('\n');
}

function commandNames(): string[] {
  return Object.values(RUNPANE_CONTRACT.agentContext.commands)
    .map((command) => command.name)
    .sort();
}
