import { boundary, decodeBoundary, type JsonObject, type JsonValue } from './boundaryDecoder';
import { RUNPANE_CONTRACT } from './generated/contract';

/**
 * The slice of the runpane contract that MCP tools are generated from. Every
 * command with result `jsonSchemas` becomes a tool; its inputs are the union of
 * the flags in its `usage` lines and its `agentContext` arguments, plus
 * `--pane-dir` for daemon commands. Its output schema is the command's `*Result` schema.
 */
export interface McpToolContract {
  commands: readonly {
    name: string;
    summary: string;
    usage: readonly string[];
    mutates?: boolean;
    additive?: boolean;
    idempotent?: boolean;
    openWorld?: boolean;
    toolsets?: readonly string[];
    jsonSchemas?: readonly string[];
  }[];
  /** Named JSON Schemas; `#/jsonSchemas/...` refs inside them resolve against the contract root. */
  jsonSchemas: unknown;
  flags: Readonly<Record<string, readonly { name: string; value?: string; description?: string }[]>>;
  agentContext: {
    commands: Readonly<Record<string, {
      details?: string;
      requiresPaneDaemon?: boolean;
      notes?: readonly string[];
      arguments: readonly { name: string; value?: string; required?: boolean; description?: string }[];
    }>>;
  };
}

interface McpToolParameter {
  flag: string;
  property: string;
  takesValue: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  command: string;
  /** Contract toolsets that serve this tool (`runpane mcp --toolsets`). */
  toolsets: readonly string[];
  description: string;
  parameters: McpToolParameter[];
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: 'string' | 'boolean'; description: string }>;
    required?: string[];
    additionalProperties: false;
  };
  outputSchema: JsonObject;
  /** MCP tool annotations; see the `additive`, `idempotent`, and `openWorld` contract fields. */
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

// --json is always passed; --follow streams forever, which a single tool call cannot return.
const OMITTED_FLAGS = new Set(['--json', '--follow', '--help']);
const FLAG_PATTERN = /--[a-z][a-z0-9-]*/g;
// Clients sometimes send numeric flags such as timeoutMs as JSON numbers.
const flagValueSchema = boundary.union(boundary.string, boundary.number);
export const CONFIRM_FLAG = '--yes';
const CONFIRM_DESCRIPTION = 'Confirm this change (the CLI\'s --yes). Pane refuses mutating calls without it.';

type ContractFlag = McpToolContract['flags'][string][number];

export function buildMcpTools(contract: McpToolContract = RUNPANE_CONTRACT): McpTool[] {
  const globalFlags = new Map(Object.values(contract.flags).flat().map((flag) => [flag.name, flag]));
  const schemas = decodeBoundary(JSON.parse(JSON.stringify(contract.jsonSchemas)), boundary.jsonObject);
  return contract.commands
    .filter((command) => command.jsonSchemas && command.jsonSchemas.length > 0)
    .map((command) => buildTool(contract, command, globalFlags, schemas));
}

function buildTool(
  contract: McpToolContract,
  command: McpToolContract['commands'][number],
  globalFlags: Map<string, ContractFlag>,
  schemas: JsonObject,
): McpTool {
  const context = contract.agentContext.commands[command.name];
  const contextArgs = new Map((context?.arguments ?? []).map((arg) => [arg.name, arg]));
  const usage = command.usage.join(' ');

  const flagNames = new Set<string>();
  for (const flag of usage.match(FLAG_PATTERN) ?? []) flagNames.add(flag);
  for (const arg of context?.arguments ?? []) {
    if (arg.name.startsWith('--')) flagNames.add(arg.name);
  }
  // Every daemon command accepts --pane-dir, even where its usage line omits it.
  if (context?.requiresPaneDaemon) flagNames.add('--pane-dir');

  const parameters: McpToolParameter[] = [];
  const properties: McpTool['inputSchema']['properties'] = {};
  const required: string[] = [];
  for (const flag of flagNames) {
    if (OMITTED_FLAGS.has(flag)) continue;
    const contextArg = contextArgs.get(flag);
    const globalFlag = globalFlags.get(flag);
    const placeholder = contextArg?.value ?? globalFlag?.value ?? usagePlaceholder(usage, flag);
    const isConfirm = flag === CONFIRM_FLAG;
    const baseDescription = isConfirm
      ? CONFIRM_DESCRIPTION
      : contextArg?.description ?? globalFlag?.description ?? '';
    const parameter = { flag, property: toProperty(flag), takesValue: placeholder !== undefined };
    parameters.push(parameter);
    properties[parameter.property] = {
      type: parameter.takesValue ? 'string' : 'boolean',
      description: placeholder ? `${baseDescription} Expects ${placeholder}.`.trim() : baseDescription,
    };
    const isRequired = !isConfirm
      && command.usage.every((line) => requiredFlagsIn(line).has(flag))
      && (contextArg === undefined || contextArg.required === true);
    if (isRequired) required.push(parameter.property);
  }

  const inputSchema: McpTool['inputSchema'] = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) inputSchema.required = required;

  const mutates = command.mutates === true;
  const title = `runpane ${command.name}`;
  return {
    name: toToolName(command.name),
    title,
    command: command.name,
    toolsets: command.toolsets ?? [],
    description: [
      command.summary,
      context?.details,
      ...(context?.notes ?? []),
      `Returns the JSON of \`runpane ${command.name} --json\`.`,
    ].filter(Boolean).join('\n'),
    parameters,
    inputSchema,
    outputSchema: buildOutputSchema(command.jsonSchemas ?? [], schemas),
    annotations: {
      title,
      readOnlyHint: !mutates,
      // The MCP default for a tool that changes state is destructive; the contract marks the additive ones.
      destructiveHint: mutates && command.additive !== true,
      idempotentHint: command.idempotent === true,
      openWorldHint: command.openWorld === true,
    },
  };
}

/**
 * An object schema accepting any of the command's `*Result` schemas, with contract-root refs
 * (`#/jsonSchemas/...`) inlined so the schema stands alone. Refs local to a result schema
 * (`#/$defs/...`) keep working because its `$defs` move to the root with it.
 */
function buildOutputSchema(names: readonly string[], schemas: JsonObject): JsonObject {
  const results = names.filter((name) => name.endsWith('Result')).map((name) => inlineContractRefs(schemas[name], schemas));
  const defs: JsonObject = {};
  const variants = results.map((result) => {
    const variant = decodeBoundary(result, boundary.jsonObject);
    const { $defs, ...rest } = variant;
    Object.assign(defs, decodeBoundary($defs ?? {}, boundary.jsonObject));
    return rest;
  });
  const outputSchema: JsonObject = variants.length === 1 ? { ...variants[0], type: 'object' } : { type: 'object', oneOf: variants };
  if (Object.keys(defs).length > 0) outputSchema.$defs = defs;
  return outputSchema;
}

const CONTRACT_REF_PREFIX = '#/jsonSchemas/';

const refSchema = boundary.object({ $ref: boundary.string });

function inlineContractRefs(node: JsonValue | undefined, schemas: JsonObject, depth = 0): JsonValue {
  if (depth > 32) throw new Error('runpane contract schema refs nest too deeply');
  if (node === undefined) throw new Error('runpane contract names a JSON schema that does not exist');
  if (Array.isArray(node)) return node.map((item) => inlineContractRefs(item, schemas, depth + 1));
  const object = asObject(node);
  if (!object) return node;
  const ref = asRef(object);
  if (ref?.startsWith(CONTRACT_REF_PREFIX)) {
    const target = ref.slice(CONTRACT_REF_PREFIX.length).split('/')
      .reduce<JsonValue | undefined>((current, segment) => (Array.isArray(current) ? current[Number(segment)] : asObject(current)?.[segment]), schemas);
    return inlineContractRefs(target, schemas, depth + 1);
  }
  const inlined = Object.fromEntries(Object.entries(object).map(([key, value]) => [key, inlineContractRefs(value, schemas, depth + 1)]));
  // Several MCP clients read `type` as one string, so `type: ["string", "null"]` becomes an equivalent `anyOf`.
  const { type, ...rest } = inlined;
  if (!Array.isArray(type) || rest.anyOf !== undefined) return inlined;
  return { ...rest, anyOf: type.map((member) => ({ type: member })) };
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  if (value === undefined || value === null || Array.isArray(value)) return undefined;
  try {
    return decodeBoundary(value, boundary.jsonObject);
  } catch {
    return undefined;
  }
}

function asRef(value: JsonObject): string | undefined {
  try {
    return decodeBoundary(value, refSchema).$ref;
  } catch {
    return undefined;
  }
}

/** Builds the argv for one tool call; the result is `runpane <argv>` with `--json`. */
export function buildToolArgv(tool: McpTool, input: JsonObject = {}): string[] {
  const argv = tool.command.split(' ');
  const known = new Set(tool.parameters.map((parameter) => parameter.property));
  const unknown = Object.keys(input).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s) for ${tool.name}: ${unknown.join(', ')}`);
  }
  for (const parameter of tool.parameters) {
    const value = input[parameter.property];
    if (value === undefined || value === null || value === false) continue;
    if (!parameter.takesValue) {
      if (value !== true) throw new Error(`${parameter.property} must be a boolean.`);
      argv.push(parameter.flag);
      continue;
    }
    // `--flag=value` keeps values that start with "-" (like "- [ ] item") from reading as flags.
    argv.push(`${parameter.flag}=${String(decodeBoundary(value, flagValueSchema))}`);
  }
  argv.push('--json');
  return argv;
}

function requiredFlagsIn(usageLine: string): Set<string> {
  let line = usageLine;
  let previous: string;
  do {
    previous = line;
    line = line.replace(/\[[^[\]]*\]|\([^()]*\)/g, '');
  } while (line !== previous);
  return new Set(line.match(FLAG_PATTERN) ?? []);
}

function usagePlaceholder(usage: string, flag: string): string | undefined {
  const match = new RegExp(`${flag} (<[^>]+>|[a-z]+(?:\\|[a-z]+)+)`).exec(usage);
  return match?.[1];
}

function toProperty(flag: string): string {
  return flag.slice(2).replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

function toToolName(command: string): string {
  return command.replace(/[\s-]+/g, '_');
}
