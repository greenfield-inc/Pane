import { boundary, type BoundarySchema } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { confirmMutation } from './daemonActions';
import { invokeDaemon } from './daemonClient';
import { describeFailure, RunpaneError } from './errors';
import { RUNPANE_CONTRACT } from './generated/contract';
import { getWrapperVersion } from './version';

/**
 * `runpane custom-commands`: the saved launch commands of the machine that answers (this one, or
 * another through `runpane workspace <machine> custom-commands ...`). The machine edits its own
 * list and picks the change up at once; entries are selected by exact, case-sensitive name.
 */

/** The resume modes the contract's `customCommandResume` schema lists, in its order. */
const RESUME_MODES = RUNPANE_CONTRACT.jsonSchemas.customCommandResume.properties.mode.enum;
type ResumeMode = typeof RESUME_MODES[number];

const resumeSchema = boundary.object({
  mode: boundary.enumeration(...RESUME_MODES),
  initialTemplate: boundary.string,
  resumeTemplate: boundary.string,
});

const listResultSchema = boundary.object({
  ok: boundary.literal(true),
  commands: boundary.array(boundary.object({
    position: boundary.number,
    name: boundary.string,
    command: boundary.string,
    resume: boundary.nullable(resumeSchema),
  })),
});

const mutationResultSchema = boundary.object({
  ok: boundary.literal(true),
  action: boundary.enumeration('added', 'updated', 'removed', 'moved'),
  name: boundary.string,
  position: boundary.nullable(boundary.number),
  previousPosition: boundary.nullable(boundary.number),
  changed: boundary.boolean,
  count: boundary.number,
});
type MutationResult = typeof mutationResultSchema extends BoundarySchema<infer Value> ? Value : never;

/** The resume fields given on the command line; the machine fills the rest from the saved entry or the defaults. */
interface CustomCommandResumePatch {
  mode?: ResumeMode;
  initialTemplate?: string;
  resumeTemplate?: string;
}

/** `runpane:custom-commands:update`: the entry's current exact name, and only the fields to change (`resume: null` clears). */
interface CustomCommandUpdateRequest {
  name: string;
  newName?: string;
  command?: string;
  resume?: CustomCommandResumePatch | null;
}

const SHORTCUT_NOTE = 'Custom command keyboard shortcuts follow list order, so the moved entries now answer to different shortcut slots.';

export async function runCustomCommandsList(parsed: ParsedArgs): Promise<number> {
  const result = await call('runpane:custom-commands:list', [], listResultSchema, parsed);
  if (parsed.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (result.commands.length === 0) {
    console.log('No custom commands on this machine. Add one with `runpane custom-commands add --name <name> --command <command> --yes`.');
    return 0;
  }
  for (const entry of result.commands) {
    console.log(`${entry.position}. ${entry.name}`);
    console.log(`   command: ${entry.command}`);
    if (entry.resume) {
      console.log(`   resume mode: ${entry.resume.mode}`);
      console.log(`   first launch template: ${entry.resume.initialTemplate}`);
      console.log(`   resume template: ${entry.resume.resumeTemplate}`);
    }
  }
  return 0;
}

export async function runCustomCommandsAdd(parsed: ParsedArgs): Promise<number> {
  const name = required(parsed.name, '--name', 'add', 'Pass the name the "+" menu shows with --name.');
  const command = required(parsed.customCommandText, '--command', 'add', 'Pass the command line to run with --command.');
  const resume = resumePatch(parsed, 'add');
  if (resume === null) throw invalid('runpane custom-commands add takes --resume-mode none only on update; a new entry has no resume settings to clear.', 'Leave out --resume-mode, or pass reported, generated, claude, codex or cursor.');
  await confirmMutation(parsed);
  return report(parsed, await call('runpane:custom-commands:add', [{ name, command, ...(resume && { resume }) }], mutationResultSchema, parsed));
}

export async function runCustomCommandsUpdate(parsed: ParsedArgs): Promise<number> {
  const name = selected(parsed, 'update');
  const request: CustomCommandUpdateRequest = { name };
  if (parsed.name !== undefined) request.newName = parsed.name;
  if (parsed.customCommandText !== undefined) request.command = parsed.customCommandText;
  const resume = resumePatch(parsed, 'update');
  if (resume !== undefined) request.resume = resume;
  if (Object.keys(request).length === 1) {
    throw invalid('runpane custom-commands update needs something to change. Nothing was changed.', 'Pass --name, --command, --resume-mode, --initial-template or --resume-template.');
  }
  await confirmMutation(parsed);
  return report(parsed, await call('runpane:custom-commands:update', [request], mutationResultSchema, parsed));
}

export async function runCustomCommandsRemove(parsed: ParsedArgs): Promise<number> {
  const name = selected(parsed, 'remove');
  await confirmMutation(parsed);
  return report(parsed, await call('runpane:custom-commands:remove', [{ name }], mutationResultSchema, parsed));
}

export async function runCustomCommandsReorder(parsed: ParsedArgs): Promise<number> {
  const name = selected(parsed, 'reorder');
  if (parsed.position === undefined) throw invalid('runpane custom-commands reorder requires --to <position>. Nothing was changed.', 'Pass the 1-based position the entry should end up at, such as --to 1.');
  if (parsed.position < 1) throw invalid('--to must be 1 or more. Nothing was changed.', 'Pass a position from 1 to the number of entries in `runpane custom-commands list`.');
  await confirmMutation(parsed);
  return report(parsed, await call('runpane:custom-commands:reorder', [{ name, position: parsed.position }], mutationResultSchema, parsed));
}

/** The resume fields given, `null` for `--resume-mode none`, or undefined when no resume flag was passed. */
function resumePatch(parsed: ParsedArgs, verb: string): CustomCommandResumePatch | null | undefined {
  const { resumeMode, initialTemplate, resumeTemplate } = parsed;
  if (resumeMode === 'none') {
    if (initialTemplate !== undefined || resumeTemplate !== undefined) {
      throw invalid(`runpane custom-commands ${verb} takes --resume-mode none (which clears the resume settings) without template flags. Nothing was changed.`, 'Drop the template flags, or pick a resume mode.');
    }
    return null;
  }
  if (resumeMode !== undefined && !isResumeMode(resumeMode)) {
    throw invalid(`Unknown --resume-mode "${resumeMode}". Nothing was changed.`, `Use one of: ${[...RESUME_MODES, 'none'].join(', ')}.`);
  }
  if (resumeMode === undefined && initialTemplate === undefined && resumeTemplate === undefined) return undefined;
  return {
    ...(resumeMode !== undefined && { mode: resumeMode }),
    ...(initialTemplate !== undefined && { initialTemplate }),
    ...(resumeTemplate !== undefined && { resumeTemplate }),
  };
}

function isResumeMode(value: string): value is ResumeMode {
  return RESUME_MODES.some((mode) => mode === value);
}

function selected(parsed: ParsedArgs, verb: string): string {
  const name = parsed.customCommandName;
  if (!name) throw invalid(`runpane custom-commands ${verb} needs the entry's exact name as its first word. Nothing was changed.`, `Run \`runpane custom-commands list\`, then \`runpane custom-commands ${verb} "<name>" ...\`.`);
  return name;
}

function required(value: string | undefined, flag: string, verb: string, next: string): string {
  if (!value?.trim()) throw invalid(`runpane custom-commands ${verb} requires a non-blank ${flag}. Nothing was changed.`, next);
  return value;
}

function invalid(message: string, next: string): RunpaneError {
  return new RunpaneError('ERR_RUNPANE_INVALID_ARGUMENT', message, next);
}

function report(parsed: ParsedArgs, result: MutationResult): number {
  const moved = result.action === 'moved' && result.changed;
  if (parsed.json) {
    console.log(JSON.stringify(moved ? { ...result, note: SHORTCUT_NOTE } : result, null, 2));
    return 0;
  }
  const quoted = JSON.stringify(result.name);
  if (result.action === 'added') console.log(`Added ${quoted} at position ${result.position} of ${result.count}.`);
  else if (result.action === 'updated') console.log(`Updated ${quoted} (position ${result.position} of ${result.count}).`);
  else if (result.action === 'removed') console.log(`Removed ${quoted}; ${result.count} custom command${result.count === 1 ? '' : 's'} left.`);
  else if (!result.changed) console.log(`${quoted} is already at position ${result.position}; nothing changed.`);
  else console.log(`Moved ${quoted} from position ${result.previousPosition} to ${result.position}. ${SHORTCUT_NOTE}`);
  return 0;
}

/** A daemon call; a Pane too old for these commands gets a clear upgrade step instead of an unknown channel. */
async function call<T>(channel: string, args: unknown[], schema: BoundarySchema<T>, parsed: ParsedArgs): Promise<T> {
  try {
    return await invokeDaemon(channel, args, schema, { paneDir: parsed.paneDir });
  } catch (error) {
    if (describeFailure(error).code !== 'ERR_UNKNOWN_CHANNEL') throw error;
    throw new RunpaneError(
      'ERR_PANE_TOO_OLD',
      `This Pane does not have custom-commands, which needs Pane ${getWrapperVersion()} or newer. Nothing was changed.`,
      'Update Pane on that machine with `runpane update`, restart it, then run the command again.',
    );
  }
}
