#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const util = require('util');

const rootDir = path.resolve(__dirname, '..');
const checkMode = process.argv.slice(2).includes('--check');

const paths = {
  contract: path.join(rootDir, 'contracts', 'runpane', 'contract.json'),
  schema: path.join(rootDir, 'contracts', 'runpane', 'schema.json'),
  npmContract: path.join(rootDir, 'packages', 'runpane', 'src', 'generated', 'contract.ts'),
  sharedContract: path.join(rootDir, 'shared', 'types', 'generatedRunpaneContract.ts'),
  pyContract: path.join(rootDir, 'packages', 'runpane-py', 'src', 'runpane', 'generated_contract.py'),
  fixture: path.join(rootDir, 'scripts', 'fixtures', 'runpane-contract.json'),
  docs: path.join(rootDir, 'docs', 'RUNPANE_CLI_CONTRACT.md')
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function relative(filePath) {
  return path.relative(rootDir, filePath);
}

function ensureArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function assertUnique(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item)) {
      throw new Error(`${label} contains duplicate value "${item}"`);
    }
    seen.add(item);
  }
}

function isObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function runtimeType(value) {
  if (Array.isArray(value)) return 'array';
  if (isObject(value)) return 'object';
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}

function pointerSegment(segment) {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveRef(schema, ref) {
  if (!ref.startsWith('#/')) {
    throw new Error(`Unsupported schema ref: ${ref}`);
  }

  return ref
    .slice(2)
    .split('/')
    .map(pointerSegment)
    .reduce((node, segment) => {
      if (!node || !Object.prototype.hasOwnProperty.call(node, segment)) {
        throw new Error(`Unknown schema ref: ${ref}`);
      }
      return node[segment];
    }, schema);
}

function typeMatches(value, type) {
  if (type === 'array') {
    return Array.isArray(value);
  }
  if (type === 'object') {
    return isObject(value);
  }
  return runtimeType(value) === type;
}

function validateJsonSchema(value, schemaNode, label, rootSchema) {
  if (schemaNode.$ref) {
    validateJsonSchema(value, resolveRef(rootSchema, schemaNode.$ref), label, rootSchema);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(schemaNode, 'const') && value !== schemaNode.const) {
    throw new Error(`${label} must be ${JSON.stringify(schemaNode.const)}`);
  }

  if (schemaNode.type && !typeMatches(value, schemaNode.type)) {
    throw new Error(`${label} must be a ${schemaNode.type}`);
  }

  if (schemaNode.type === 'string') {
    if (schemaNode.minLength && value.length < schemaNode.minLength) {
      throw new Error(`${label} must not be empty`);
    }
    if (schemaNode.pattern && !new RegExp(schemaNode.pattern).test(value)) {
      throw new Error(`${label} must match ${schemaNode.pattern}`);
    }
  }

  if (schemaNode.type === 'array') {
    if (schemaNode.minItems && value.length < schemaNode.minItems) {
      throw new Error(`${label} must contain at least ${schemaNode.minItems} item(s)`);
    }
    if (schemaNode.uniqueItems) {
      assertUnique(value.map((item) => JSON.stringify(item)), label);
    }
    if (schemaNode.items) {
      value.forEach((item, index) => {
        validateJsonSchema(item, schemaNode.items, `${label}[${index}]`, rootSchema);
      });
    }
  }

  if (schemaNode.type === 'object') {
    const required = schemaNode.required ?? [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        throw new Error(`${label}.${key} is required`);
      }
    }

    const properties = schemaNode.properties ?? {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateJsonSchema(value[key], propertySchema, `${label}.${key}`, rootSchema);
      }
    }

    const knownKeys = new Set(Object.keys(properties));
    const extraKeys = Object.keys(value).filter((key) => !knownKeys.has(key));
    if (schemaNode.additionalProperties === false && extraKeys.length > 0) {
      throw new Error(`${label} has unsupported key(s): ${extraKeys.join(', ')}`);
    }
    if (isObject(schemaNode.additionalProperties)) {
      for (const key of extraKeys) {
        validateJsonSchema(value[key], schemaNode.additionalProperties, `${label}.${key}`, rootSchema);
      }
    }
  }
}

function validateContract(contract, schema) {
  if (schema.title !== 'Runpane public contract manifest') {
    throw new Error('Unexpected runpane contract schema');
  }
  validateJsonSchema(contract, schema, 'contract', schema);

  if (contract.schemaVersion !== 1) {
    throw new Error('runpane contract schemaVersion must be 1');
  }
  if (contract.name !== 'runpane') {
    throw new Error('runpane contract name must be "runpane"');
  }

  const commandNames = ensureArray(contract.commands, 'commands').map((command) => command.name);
  assertUnique(commandNames, 'commands');
  for (const required of ['help', 'setup', 'install', 'update', 'version', 'doctor', 'daemon repair', 'agent-context', 'agents doctor', 'repos list', 'repos add', 'panes list', 'panes create', 'workspace state', 'watch', 'panels create', 'panels list', 'panels output', 'panels input', 'panels screen', 'panels submit', 'panels submit-composer', 'panels wait']) {
    if (!commandNames.includes(required)) {
      throw new Error(`commands must include "${required}"`);
    }
  }

  for (const [key, values] of Object.entries(contract.enums ?? {})) {
    assertUnique(ensureArray(values, `enums.${key}`), `enums.${key}`);
  }

  if (!contract.enums.installTargets.includes(contract.defaults.target)) {
    throw new Error('defaults.target must be one of enums.installTargets');
  }
  if (!contract.enums.artifactFormats.includes(contract.defaults.format)) {
    throw new Error('defaults.format must be one of enums.artifactFormats');
  }
  if (!contract.enums.channels.includes(contract.defaults.channel)) {
    throw new Error('defaults.channel must be one of enums.channels');
  }

  for (const agent of contract.enums.agents) {
    const template = contract.agentTemplates?.[agent];
    if (!template) {
      throw new Error(`agentTemplates.${agent} is required`);
    }
    if (runtimeType(template.title) !== 'string' || runtimeType(template.command) !== 'string') {
      throw new Error(`agentTemplates.${agent} must include title and command`);
    }
  }

  const flagNamesAndAliases = (flags) => flags.flatMap((flag) => [flag.name, ...(flag.aliases ?? [])]);
  const remoteValueFlags = ensureArray(contract.flags?.remoteValue, 'flags.remoteValue').map((flag) => flag.name);
  const remoteBooleanFlags = ensureArray(contract.flags?.remoteBoolean, 'flags.remoteBoolean').map((flag) => flag.name);
  const wrapperFlags = flagNamesAndAliases(ensureArray(contract.flags?.wrapper, 'flags.wrapper'));
  const localValueFlags = flagNamesAndAliases(ensureArray(contract.flags?.localValue, 'flags.localValue'));
  const localBooleanFlags = flagNamesAndAliases(ensureArray(contract.flags?.localBoolean, 'flags.localBoolean'));
  assertUnique([...remoteValueFlags, ...remoteBooleanFlags], 'remote flags');
  assertUnique(wrapperFlags, 'wrapper flags');
  assertUnique([...localValueFlags, ...localBooleanFlags], 'local flags');

  for (const surface of ['npm', 'pip']) {
    const help = contract.help?.[surface];
    if (!help) {
      throw new Error(`help.${surface} is required`);
    }
    for (const topic of ['default', ...commandNames.filter((name) => name !== 'help')]) {
      const lines = help[topic];
      if (!Array.isArray(lines) || lines.length === 0) {
        throw new Error(`help.${surface}.${topic} must be a non-empty array`);
      }
    }
  }

  const samples = contract.testFixtures?.parserSamples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error('testFixtures.parserSamples must be a non-empty array');
  }

  validateAgentContext(contract, commandNames);
}

function validateAgentContext(contract, commandNames) {
  const context = contract.agentContext;
  if (!context || !isObject(context)) {
    throw new Error('agentContext is required');
  }

  const detailedCommands = context.commands;
  if (!isObject(detailedCommands)) {
    throw new Error('agentContext.commands must be an object');
  }

  for (const name of commandNames) {
    const detail = detailedCommands[name];
    if (!detail) {
      throw new Error(`agentContext.commands.${name} is required`);
    }
    if (detail.name !== name) {
      throw new Error(`agentContext.commands.${name}.name must match the command name`);
    }
    for (const schemaName of detail.jsonSchemas ?? []) {
      if (!contract.jsonSchemas?.[schemaName]) {
        throw new Error(`agentContext.commands.${name}.jsonSchemas references unknown schema "${schemaName}"`);
      }
    }
  }

  const commandNameSet = new Set(commandNames);
  for (const tool of context.brief?.tools ?? []) {
    if (!commandNameSet.has(tool.name)) {
      throw new Error(`agentContext.brief.tools references unknown command "${tool.name}"`);
    }
  }
}

function header(commentStart) {
  return `${commentStart} Generated by scripts/generate-runpane-contract.js. Do not edit by hand.\n`;
}

function renderTypeScript(contract) {
  return [
    header('//'),
    `export const RUNPANE_CONTRACT = ${JSON.stringify(contract, null, 2)} as const;`,
    '',
    "export type RunpaneCommand = typeof RUNPANE_CONTRACT.commands[number]['name'];",
    "export type InstallTarget = typeof RUNPANE_CONTRACT.enums.installTargets[number];",
    "export type ArtifactFormat = typeof RUNPANE_CONTRACT.enums.artifactFormats[number];",
    "export type RunpaneChannel = typeof RUNPANE_CONTRACT.enums.channels[number];",
    "export type RunpaneAgent = typeof RUNPANE_CONTRACT.enums.agents[number];",
    ''
  ].join('\n');
}

function renderPython(contract) {
  return [
    '# Generated by scripts/generate-runpane-contract.js. Do not edit by hand.',
    'import json',
    '',
    `RUNPANE_CONTRACT = json.loads(${JSON.stringify(JSON.stringify(contract, null, 2))})`,
    ''
  ].join('\n');
}

function renderFixture(contract) {
  return JSON.stringify({
    schemaVersion: contract.schemaVersion,
    parserSamples: contract.testFixtures.parserSamples,
    help: {
      topLevelIncludes: contract.testFixtures.topLevelHelpIncludes,
      npmIncludes: contract.testFixtures.npmHelpIncludes,
      pipIncludes: contract.testFixtures.pipHelpIncludes,
      installIncludes: contract.testFixtures.installHelpIncludes
    }
  }, null, 2) + '\n';
}

function fenced(lines, language = 'bash') {
  return ['```' + language, ...lines, '```'].join('\n');
}

function flagLines(flags) {
  return flags.map((flag) => {
    const aliases = flag.aliases?.length ? ` (aliases: ${flag.aliases.join(', ')})` : '';
    return `${flag.name}${flag.value ? ` ${flag.value}` : ''}${aliases}`;
  });
}

function renderMarkdown(contract) {
  const lines = [
    '# Runpane CLI Contract',
    '',
    '<!-- Generated by scripts/generate-runpane-contract.js. Do not edit generated sections by hand. -->',
    '',
    '`runpane` is a thin installer and configurator for Pane. The npm and PyPI',
    'packages expose the same command contract and download the real Pane release',
    'artifact at command runtime.',
    ''
  ];

  lines.push(...contract.packageInstallPolicy, '');

  lines.push('## Maintainer Rules', '');
  for (const rule of contract.docs.maintainerRules) {
    lines.push(`- ${rule}`);
  }
  lines.push('');

  lines.push('## Compatibility Floors', '');
  lines.push(`The npm wrapper should run on Node.js \`${contract.compatibility.node}\` and newer. The root Electron app`);
  lines.push('may require a newer Node.js version for development and packaging.', '');
  lines.push(`The PyPI wrapper should run on Python \`${contract.compatibility.python}\` and newer. Keep runtime dependencies`);
  lines.push('out of the wrapper unless a compatibility test covers the new dependency.', '');

  lines.push('## Public Terminology', '');
  for (const [term, description] of Object.entries(contract.terminology)) {
    lines.push(`- \`${term}\`: ${description}`);
  }
  lines.push('');

  lines.push('## Package Manager Entrypoints', '');
  lines.push('Recommended guided quick starts:', '', fenced(contract.docs.recommendedQuickStarts), '');
  lines.push('Canonical npm and Node commands:', '', fenced(contract.docs.npmCommands), '');
  lines.push('Canonical Python commands:', '', fenced(contract.docs.pythonCommands), '');
  lines.push(...contract.docs.packageManagerNotes, '');

  lines.push('## Commands', '', fenced(contract.docs.commandUsages), '');
  for (const description of contract.docs.commandDescriptions) {
    lines.push(description, '');
  }

  lines.push(
    '## Command reference',
    '',
    'Every command and its options, from `commands` in `contracts/runpane/contract.json`.',
    '',
  );
  for (const command of contract.commands) {
    lines.push(`- \`${command.name}\`: ${command.summary}`);
  }
  lines.push('', fenced(contract.commands.flatMap((command) => command.usage)), '');

  lines.push('## Agent Context', '');
  lines.push(contract.agentContext.brief.summary, '');
  lines.push('Doctor-first environment discovery:', '', fenced(['runpane doctor --json']), '');
  lines.push('Brief CLI context:', '', fenced(['runpane agent-context', 'runpane agent-context --json']), '');
  lines.push('Detailed command discovery:', '', fenced([contract.agentContext.brief.detailCommand]), '');
  lines.push('Brief tools:', '');
  for (const tool of contract.agentContext.brief.tools) {
    lines.push(`- \`${tool.name}\`: ${tool.summary}`);
  }
  lines.push('');
  lines.push('Managed AGENTS.md block body:', '', fenced(contract.agentContext.managedBlock, 'md'), '');

  lines.push('## Wrapper Flags', '');
  lines.push('These flags are consumed by the wrapper:', '', fenced(flagLines(contract.flags.wrapper)), '');
  lines.push(contract.docs.wrapperFlagNote, '');

  lines.push('## Local Control Flags', '');
  lines.push('These flags are consumed by local daemon-control commands:', '', fenced(flagLines([...contract.flags.localValue, ...contract.flags.localBoolean])), '');
  lines.push(contract.docs.localControlFlagNote, '');

  lines.push('## Daemon Passthrough Flags', '');
  lines.push('`runpane install daemon` forwards these flags to `pane --remote-setup`:', '');
  lines.push(fenced([...flagLines(contract.flags.remoteValue), ...flagLines(contract.flags.remoteBoolean)]), '');
  lines.push(contract.docs.daemonFlagNote, '');

  lines.push('## Machine-Readable Schemas', '');
  lines.push('Stable `--json` response schemas live in `contracts/runpane/contract.json` under `jsonSchemas`.');
  lines.push('OpenAPI should be generated later from the stable local HTTP/API subset of the same contract, not maintained as a second source of truth.', '');

  lines.push('## Download Attribution', '');
  lines.push(...contract.docs.downloadAttribution, '');

  lines.push('## Publishing Credentials', '');
  lines.push(...contract.docs.publishingCredentials, '');

  return lines.join('\n');
}

function writeOrCheck(filePath, content, failures) {
  if (checkMode) {
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    if (current !== content) {
      failures.push(relative(filePath));
    }
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function main() {
  const contract = readJson(paths.contract);
  const schema = readJson(paths.schema);
  validateContract(contract, schema);

  const outputs = new Map([
    [paths.npmContract, renderTypeScript(contract)],
    [paths.sharedContract, renderTypeScript(contract)],
    [paths.pyContract, renderPython(contract)],
    [paths.fixture, renderFixture(contract)],
    [paths.docs, renderMarkdown(contract)]
  ]);

  const failures = [];
  for (const [filePath, content] of outputs) {
    writeOrCheck(filePath, content, failures);
  }

  if (failures.length > 0) {
    console.error('runpane contract generated files are out of date:');
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    console.error('Run: node scripts/generate-runpane-contract.js');
    process.exit(1);
  }

  console.log(checkMode
    ? 'runpane contract generated files are up to date'
    : `Generated runpane contract artifacts:\n${util.inspect([...outputs.keys()].map(relative), { maxArrayLength: null })}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
