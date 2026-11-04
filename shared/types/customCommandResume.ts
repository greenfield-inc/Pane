import { boundary, decodeBoundary } from '../validation/boundaryDecoder';

export interface CustomCommandResume {
  mode: 'claude' | 'codex' | 'cursor' | 'generated' | 'reported';
  initialTemplate: string;
  resumeTemplate: string;
}

export const customCommandResumeSchema = boundary.object({
  mode: boundary.enumeration('claude', 'codex', 'cursor', 'generated', 'reported'),
  initialTemplate: boundary.string,
  resumeTemplate: boundary.nonEmptyString,
});

export function validateCustomCommandResume(value: CustomCommandResume): CustomCommandResume {
  const config = decodeBoundary(value, customCommandResumeSchema);
  if (!config.resumeTemplate.includes('{sessionId}')) throw new Error('Resume command must contain {sessionId}');
  if ((config.mode === 'generated' || config.mode === 'claude') && !config.initialTemplate.includes('{sessionId}')) {
    throw new Error('First launch command must contain {sessionId} for allocated IDs');
  }
  if (config.initialTemplate.length > 10000 || config.resumeTemplate.length > 10000) throw new Error('Resume command is too long');
  return config;
}

export function customResumeAgentType(config?: CustomCommandResume | null): 'claude' | 'codex' | 'cursor' | undefined {
  const mode = config?.mode;
  return mode === 'claude' || mode === 'codex' || mode === 'cursor' ? mode : undefined;
}

/**
 * Agent Farm's published contract for Pane: under PANE_PANEL_ID it prints
 * `PANE_AGENT_SESSION_ID=<launch id>` once, before the agent starts, and
 * `agent-farm run <profile> --resume <id>` reopens that conversation.
 */
export const AGENT_FARM_RESUME: CustomCommandResume = {
  mode: 'reported',
  initialTemplate: '{command}',
  resumeTemplate: '{command} --resume {sessionId}',
};

export type EffectiveCustomResumeSource = 'explicit' | 'agent-farm';

export interface EffectiveCustomResume {
  config: CustomCommandResume;
  source: EffectiveCustomResumeSource;
}

/**
 * The resume config every reader of a panel uses: the panel's own config when
 * one is set, otherwise Agent Farm's contract for a recognized `agent-farm`
 * command. The Agent Farm config is derived, never saved, so Session refreshes
 * and panels created before this rule see the same answer.
 */
export function effectiveCustomResume(state: {
  initialCommand?: string;
  customResume?: CustomCommandResume | null;
}): EffectiveCustomResume | undefined {
  if (state.customResume) return { config: state.customResume, source: 'explicit' };
  if (isAgentFarmLaunchCommand(state.initialCommand)) return { config: AGENT_FARM_RESUME, source: 'agent-farm' };
  return undefined;
}

/**
 * Whether a command is one `agent-farm run|agent` invocation that Pane can
 * resume by appending `--resume <id>`: optional `VAR=value` prefixes, no shell
 * operators or command substitution, no `--` native-argument separator, and no
 * `--resume` of its own. npx, pnpm dlx and aliases are not recognized.
 */
export function isAgentFarmLaunchCommand(command: string | undefined): boolean {
  const words = command ? simpleCommandWords(command) : undefined;
  if (!words) return false;
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
  const executable = words[index];
  if (!executable || executable.split('/').pop() !== 'agent-farm') return false;
  const args = words.slice(index + 1);
  if (args[0] !== 'run' && args[0] !== 'agent') return false;
  return !args.some(arg => arg === '--' || arg === '--resume' || arg.startsWith('--resume='));
}

/**
 * Split a single simple shell command into words, or return undefined when it
 * is anything else (operators, redirects, substitutions, unbalanced quotes).
 */
function simpleCommandWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (char === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++) {
        const inner = command[j]!;
        if (inner === '`' || (inner === '$' && command[j + 1] === '(')) return undefined;
        if (inner === '\\' && j + 1 < command.length) j++;
        word += command[j];
      }
      if (j >= command.length) return undefined;
      inWord = true;
      i = j;
    } else if (char === '\\') {
      if (i + 1 >= command.length || command[i + 1] === '\n') return undefined;
      word += command[++i];
      inWord = true;
    } else if (char === ' ' || char === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (/[;&|<>()`\n\r]/.test(char) || (char === '$' && command[i + 1] === '(')) {
      return undefined;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}
