import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { decodeJsonLine } from '../agentTranscript/tail';

/** The fields Pane reads from a Claude Code hook's JSON input (https://code.claude.com/docs/en/hooks). */
const claudeHookEventSchema = boundary.object({
  hook_event_name: boundary.nonEmptyString,
  session_id: boundary.string,
  cwd: boundary.optional(boundary.string),
  transcript_path: boundary.optional(boundary.string),
  tool_name: boundary.optional(boundary.string),
  tool_input: boundary.optional(boundary.jsonObject),
  permission_suggestions: boundary.optional(boundary.array(boundary.jsonObject)),
});

export type ClaudeHookEvent = ReturnType<typeof claudeHookEventSchema.decode>;

/** One hook request body; undefined when it isn't a hook event. */
export function parseClaudeHookEvent(text: string): ClaudeHookEvent | undefined {
  return decodeJsonLine(text, claudeHookEventSchema);
}

/** The tool input fields the prompt card names. */
const toolInputTextSchema = boundary.object({
  command: boundary.optional(boundary.string),
  description: boundary.optional(boundary.string),
  file_path: boundary.optional(boundary.string),
  notebook_path: boundary.optional(boundary.string),
  url: boundary.optional(boundary.string),
  prompt: boundary.optional(boundary.string),
  query: boundary.optional(boundary.string),
  plan: boundary.optional(boundary.string),
});

export type ClaudeToolInputText = ReturnType<typeof toolInputTextSchema.decode>;

export function toolInputText(input: JsonObject): ClaudeToolInputText {
  // A field of another type reads as absent, as every field does when the input is unreadable.
  return decodeOptionalBoundary(input, toolInputTextSchema) ?? decodeBoundary({}, toolInputTextSchema);
}

const destinationSchema = boundary.optional(boundary.enumeration('session', 'localSettings', 'projectSettings', 'userSettings', 'cliArg'));

/** The `permission_suggestions` kinds the terminal dialog offers as "don't ask again" choices. */
const permissionSuggestionSchema = boundary.union(
  boundary.object({
    type: boundary.literal('addRules'),
    behavior: boundary.literal('allow'),
    rules: boundary.array(boundary.object({ toolName: boundary.string, ruleContent: boundary.optional(boundary.string) })),
    destination: destinationSchema,
  }),
  boundary.object({ type: boundary.literal('addDirectories'), directories: boundary.array(boundary.string), destination: destinationSchema }),
  boundary.object({ type: boundary.literal('setMode'), mode: boundary.string, destination: destinationSchema }),
);

export type ClaudePermissionSuggestion = ReturnType<typeof permissionSuggestionSchema.decode>;

/** A suggestion Pane can name; undefined for other kinds. */
export function permissionSuggestion(value: JsonObject): ClaudePermissionSuggestion | undefined {
  return decodeOptionalBoundary(value, permissionSuggestionSchema);
}

/** The transcript content blocks that say a tool call was made, and answered. */
const transcriptBlockSchema = boundary.union(
  boundary.object({ type: boundary.literal('tool_use'), id: boundary.string, name: boundary.string, input: boundary.jsonObject }),
  boundary.object({ type: boundary.literal('tool_result'), tool_use_id: boundary.string }),
);
const transcriptLineSchema = boundary.object({
  message: boundary.object({ content: boundary.array(boundary.jsonObject) }),
});

export type ClaudeTranscriptBlock = ReturnType<typeof transcriptBlockSchema.decode>;

/** The tool calls and results on one transcript line; none for other lines. */
export function transcriptBlocks(line: string): ClaudeTranscriptBlock[] {
  const content = decodeJsonLine(line, transcriptLineSchema)?.message.content ?? [];
  return content.flatMap(block => decodeOptionalBoundary(block, transcriptBlockSchema) ?? []);
}
