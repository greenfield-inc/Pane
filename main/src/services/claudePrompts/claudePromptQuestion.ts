import path from 'path';
import type { NotifyChoice, NotifyQuestion } from '../../../../shared/types/notify';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { permissionSuggestion, toolInputText, type ClaudeHookEvent, type ClaudePermissionSuggestion } from './claudeHookEvent';

/** A PermissionRequest hook decision (hookSpecificOutput.decision). */
export type ClaudePermissionDecision =
  | { behavior: 'allow'; updatedInput?: JsonObject; updatedPermissions?: JsonObject[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export interface ClaudePromptQuestion {
  question: NotifyQuestion;
  /** The hook decision for one of the question's choices. */
  decide(choice: string, note?: string): ClaudePermissionDecision;
}

/** What the card says about the tool call. */
interface PromptText {
  title: string;
  context?: string;
}

const MAX_CHOICES = 9;
const MAX_CONTEXT = 4_000;
const MAX_TITLE_COMMAND = 160;
/** Claude's dialog says No; a note tells Claude what to do instead. */
const DENY = 'No';
const DENIED_IN_PANE = 'The user said no in Pane. Stop and wait for their next message.';
/** Claude reads a deny message as tool output; saying whose words these are lets it act on them. */
const userSaid = (note: string, verdict: string) => `${verdict} The user answered this prompt in Pane and wrote: ${note}`;

const PLAN_MODES = [
  { label: 'Yes, and auto-accept edits', mode: 'acceptEdits' },
  { label: 'Yes, and manually approve edits', mode: 'default' },
] as const;
const KEEP_PLANNING = 'No, keep planning';

const MODE_NAMES = new Map([
  ['acceptEdits', 'accept edits'],
  ['auto', 'auto mode'],
  ['default', 'ask before edits'],
  ['plan', 'plan mode'],
  ['dontAsk', "don't ask mode"],
  ['bypassPermissions', 'bypass permissions'],
]);

/**
 * The Notify question for one Claude permission or plan prompt, with the choices the terminal
 * dialog offers, and the hook decision each choice sends. `project` names where Claude keeps a
 * project's "don't ask again" rules: the repository, which a worktree shares.
 */
export function claudePromptQuestion(request: ClaudeHookEvent, project = request.cwd ? path.basename(request.cwd) : undefined): ClaudePromptQuestion {
  const input = request.tool_input ?? {};
  const text = toolInputText(input);
  if (request.tool_name === 'ExitPlanMode') {
    return {
      question: {
        ui: 'options',
        title: "Approve Claude's plan?",
        context: clip(text.plan ?? '', MAX_CONTEXT) || undefined,
        choices: [...PLAN_MODES.map(({ label }) => ({ label })), { label: KEEP_PLANNING, detail: 'Add a note with what to change' }],
        agentPrompt: { yes: PLAN_MODES[0].label, no: KEEP_PLANNING },
      },
      decide: (choice, note) => {
        const mode = PLAN_MODES.find(candidate => candidate.label === choice)?.mode;
        // Claude needs the plan echoed back to approve it; setMode picks the mode it leaves plan mode in.
        if (mode) return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] };
        const reason = note?.trim();
        return { behavior: 'deny', message: reason ? userSaid(reason, 'The user wants to keep planning.') : 'The user wants to keep planning.' };
      },
    };
  }

  // Each suggestion is echoed back exactly as Claude sent it.
  const remembered = new Map<string, JsonObject>();
  for (const raw of request.permission_suggestions ?? []) {
    const suggestion = permissionSuggestion(raw);
    const label = suggestion && suggestionLabel(suggestion, request.cwd, project);
    if (label && !remembered.has(label) && remembered.size < MAX_CHOICES - 2) remembered.set(label, raw);
  }
  const choices: NotifyChoice[] = [
    { label: 'Yes' },
    ...[...remembered.keys()].map(label => ({ label })),
    { label: DENY, detail: 'Add a note to tell Claude what to do instead; without one, Claude stops and waits' },
  ];
  return {
    question: { ui: 'options', ...describeTool(request.tool_name ?? '', input, request.cwd), choices, agentPrompt: { yes: 'Yes', no: DENY } },
    decide: (choice, note) => {
      if (choice === 'Yes') return { behavior: 'allow' };
      const suggestion = remembered.get(choice);
      if (suggestion) return { behavior: 'allow', updatedPermissions: [suggestion] };
      const message = note?.trim();
      return message ? { behavior: 'deny', message: userSaid(message, 'The user said no.') } : { behavior: 'deny', message: DENIED_IN_PANE, interrupt: true };
    },
  };
}

/** The card's title and context for a tool call, as the terminal dialog names it. */
function describeTool(tool: string, input: JsonObject, cwd: string | undefined): PromptText {
  const text = toolInputText(input);
  const file = text.file_path ?? text.notebook_path;
  const shown = file && cwd ? relativeTo(cwd, file) : file;
  switch (tool) {
    case 'Bash':
    case 'PowerShell': {
      const command = text.command ?? '';
      const oneLine = command.replace(/\s+/g, ' ').trim();
      const full = oneLine.length > MAX_TITLE_COMMAND || command.includes('\n') ? command : undefined;
      return {
        title: `Run ${clip(oneLine, MAX_TITLE_COMMAND)}?`,
        context: clip([text.description, full].filter(Boolean).join('\n\n'), MAX_CONTEXT) || undefined,
      };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { title: `Edit ${shown ?? 'a file'}?` };
    case 'Write':
      return { title: `Write ${shown ?? 'a file'}?` };
    case 'Read':
      return { title: `Read ${shown ?? 'a file'}?` };
    case 'WebFetch':
      return { title: `Fetch ${text.url ?? 'a web page'}?`, context: text.prompt };
    case 'WebSearch':
      return { title: `Search the web for “${text.query ?? ''}”?` };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  const context = Object.keys(input).length > 0 ? clip(JSON.stringify(input, null, 2), MAX_CONTEXT) : undefined;
  if (mcp) return { title: `Use ${mcp[2]} from ${mcp[1]}?`, context };
  return { title: `Use ${tool}?`, context };
}

/** The "don't ask again" choice for one suggestion. */
function suggestionLabel(suggestion: ClaudePermissionSuggestion, cwd: string | undefined, project: string | undefined): string | undefined {
  const where = destinationName(suggestion.destination, project);
  switch (suggestion.type) {
    case 'addRules':
      return suggestion.rules.length > 0 ? `Yes, and don't ask again for ${suggestion.rules.map(ruleName).join(', ')} ${where}` : undefined;
    case 'addDirectories': {
      if (suggestion.directories.length === 0) return undefined;
      const folders = suggestion.directories.map(directory => (directory === cwd ? 'this folder' : directory));
      return `Yes, and allow access to ${folders.join(', ')} ${where}`;
    }
    case 'setMode':
      return `Yes, and switch to ${MODE_NAMES.get(suggestion.mode) ?? suggestion.mode}`;
  }
}

/** `Bash(pnpm vitest:*)` reads "pnpm vitest commands"; other rules keep their tool and content. */
function ruleName(rule: { toolName: string; ruleContent?: string }): string {
  if (!rule.ruleContent) return rule.toolName;
  if (rule.toolName === 'Bash' || rule.toolName === 'PowerShell') {
    const prefix = /^(.*?)(?::\*| \*)$/.exec(rule.ruleContent)?.[1];
    return prefix ? `${prefix} commands` : rule.ruleContent;
  }
  return `${rule.toolName}(${rule.ruleContent})`;
}

function destinationName(destination: ClaudePermissionSuggestion['destination'], project: string | undefined): string {
  if (destination === 'session') return 'for this session';
  if (destination === 'userSettings') return 'in every project';
  return project ? `in ${project}` : 'in this project';
}

function relativeTo(cwd: string, file: string): string {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
