#!/usr/bin/env node

/**
 * Writes Pane's bundled profiles (main/src/services/profiles/bundled/) from the Agent Farm
 * package Pane ships (@greenfieldco/agent-farm, pinned in package.json).
 *
 * - greenfield.profile.yaml: only the block between the `# BEGIN agents` and `# END agents`
 *   lines. Each agent's CLI, model, effort, role prompt (its definition file, read as
 *   agents/<name>), instruction files and skills come from the
 *   greenfield plugin's profile variant and agent definition named in GREENFIELD_AGENTS. The
 *   flow, samples and example runs around it are written by hand and never touched here.
 * - dcouple.<profile>.profile.yaml: one launchable profile per Agent Farm profile in the dcouple
 *   plugin, from its default variant. dcouple's profiles have no flow, so each one is a single
 *   agent step that ends the run when its agent reports `done`.
 *
 * Instruction files and skills are referenced from the bundled plugin, not copied.
 *
 * Usage: node scripts/import-agent-farm-profiles.js [--check]
 *   --check exits 1 when a bundled profile differs from what the package would write.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'main', 'src', 'services', 'profiles', 'bundled');
const BEGIN = '# BEGIN agents';
const END = '# END agents';

/** greenfield's agents in the profile → the Agent Farm profile and variant each one runs. */
const GREENFIELD_AGENTS = {
  planner: { profile: 'planner', variant: 'claude' },
  implementer: { profile: 'implementer', variant: 'opus' },
  reviewer: { profile: 'reviewer', variant: 'codex' },
  orchestrator: { profile: 'orchestrator', variant: 'claude' },
  'qa-lead': { profile: 'qa-and-fix', variant: 'claude' },
};
/** Plugins whose every profile is bundled as a one-step profile of its own. */
const SINGLE_STEP_PLUGINS = ['dcouple'];

function pluginsRoot() {
  return path.join(path.dirname(require.resolve('@greenfieldco/agent-farm/package.json', { paths: [path.join(ROOT, 'main')] })), 'plugins');
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.CORE_SCHEMA });
}

/** An agent definition (agents/<name>.md): its YAML front matter, and whether a role prompt follows it. */
function agentDefinition(pluginRoot, name) {
  const text = fs.readFileSync(path.join(pluginRoot, 'agents', `${name}.md`), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) throw new Error(`${name}.md in ${pluginRoot} has no front matter.`);
  return { ...yaml.load(match[1], { schema: yaml.CORE_SCHEMA }), hasPrompt: text.slice(match[0].length).trim() !== '' };
}

/** One profile agent from an Agent Farm profile's variant: runs, effort, reads and skills. */
function importAgent(pluginRoot, profileName, variantName) {
  const profile = readYaml(path.join(pluginRoot, 'profiles', `${profileName}.yaml`));
  const chosen = variantName ?? profile.default ?? Object.keys(profile.variants ?? {})[0];
  const variant = profile.variants?.[chosen] ?? profile;
  if (!variant?.agent) throw new Error(`${path.basename(pluginRoot)}/${profileName} has no variant "${chosen}" with an agent.`);
  const definition = agentDefinition(pluginRoot, variant.agent);
  const harness = variant.harness ?? definition.harness;
  const model = variant.model?.name ?? definition.model?.name;
  const effort = variant.model?.reasoning ?? definition.model?.reasoning;
  // The definition's own body is the agent's role prompt; it is read from the plugin like its instruction files.
  const reads = [
    ...(definition.hasPrompt ? [`agents/${variant.agent}`] : []),
    ...(definition.instructions_files ?? [])
      .filter((file) => /^\.\.\/instructions\/[^/]+\.md$/.test(file))
      .map((file) => path.basename(file, '.md')),
  ];
  const agent = { runs: model ? `${harness}/${model}` : harness };
  if (effort) agent.effort = effort;
  if (reads.length) agent.reads = reads;
  if (definition.skills?.length) agent.skills = definition.skills;
  return agent;
}

function dumpAgents(agents) {
  return yaml.dump({ agents }, { flowLevel: 3, lineWidth: 1000, noRefs: true, quotingType: '"' }).trimEnd();
}

/** greenfield.profile.yaml with its agents block written from the package. */
function greenfieldProfile(current, pluginRoot) {
  const plugin = readYaml(path.join(pluginRoot, 'plugin.yaml'));
  const agents = Object.fromEntries(Object.entries(GREENFIELD_AGENTS).map(([id, source]) => [id, importAgent(pluginRoot, source.profile, source.variant)]));
  const block = [
    `${BEGIN}: written by \`node scripts/import-agent-farm-profiles.js\` from Agent Farm's greenfield plugin ${plugin.version}; don't edit by hand.`,
    dumpAgents(agents),
    END,
  ].join('\n');
  const start = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (start < 0 || end < start) throw new Error(`greenfield.profile.yaml has no "${BEGIN}" … "${END}" block.`);
  return `${current.slice(0, start)}${block}${current.slice(end + END.length)}`;
}

/** The agent definition a profile's default variant runs. */
function defaultDefinition(pluginRoot, profileName) {
  const profile = readYaml(path.join(pluginRoot, 'profiles', `${profileName}.yaml`));
  const variant = profile.variants?.[profile.default] ?? Object.values(profile.variants ?? {})[0] ?? profile;
  return agentDefinition(pluginRoot, variant.agent);
}

/** One Agent Farm profile as a launchable Pane profile: its agent, in one step that ends the run. */
function singleStepProfile(pluginRoot, profileName) {
  const plugin = readYaml(path.join(pluginRoot, 'plugin.yaml'));
  const description = String(defaultDefinition(pluginRoot, profileName).description ?? `Run ${plugin.name}/${profileName}`).trim();
  const header = {
    format: 'pane-profile/1',
    name: `${plugin.name}-${profileName}`,
    version: plugin.version,
    title: description,
  };
  const flow = {
    start: 'work',
    work: { agent: profileName, goal: description.replace(/\.$/u, ''), outcomes: { done: 'end' } },
  };
  const samples = {
    work: { done: ['Done: what it did, with links to what it made.', 'Done: what it found, and what is left for you to decide.'] },
  };
  const dump = (value) => yaml.dump(value, { flowLevel: 3, lineWidth: 1000, noRefs: true, quotingType: '"' }).trimEnd();
  return [
    `# ${plugin.name}/${profileName}: written by \`node scripts/import-agent-farm-profiles.js\` from Agent Farm's ${plugin.name} plugin ${plugin.version}; don't edit by hand.`,
    '# A single agent step: the run ends when the agent reports done.',
    dump(header),
    '',
    dumpAgents({ [profileName]: importAgent(pluginRoot, profileName) }),
    '',
    dump({ flow }),
    '',
    dump({ samples }),
    '',
  ].join('\n');
}

/** Every bundled profile file this package produces: file name → contents. */
function importedProfiles(root = pluginsRoot(), currentGreenfield = fs.readFileSync(path.join(OUT, 'greenfield.profile.yaml'), 'utf8')) {
  const files = { 'greenfield.profile.yaml': greenfieldProfile(currentGreenfield, path.join(root, 'greenfield')) };
  for (const plugin of SINGLE_STEP_PLUGINS) {
    const pluginRoot = path.join(root, plugin);
    for (const file of fs.readdirSync(path.join(pluginRoot, 'profiles')).filter((entry) => entry.endsWith('.yaml')).sort()) {
      files[`${plugin}.${path.basename(file, '.yaml')}.profile.yaml`] = singleStepProfile(pluginRoot, path.basename(file, '.yaml'));
    }
  }
  return files;
}

function main() {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const [file, contents] of Object.entries(importedProfiles())) {
    const target = path.join(OUT, file);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : undefined;
    if (current === contents) continue;
    if (check) stale.push(file);
    else fs.writeFileSync(target, contents);
  }
  if (stale.length) {
    console.error(`[import-agent-farm-profiles] Out of date with the bundled Agent Farm: ${stale.join(', ')}. Run node scripts/import-agent-farm-profiles.js and commit the result.`);
    process.exit(1);
  }
  console.log(`[import-agent-farm-profiles] ${check ? 'Up to date' : 'Written'}: ${OUT}`);
}

if (require.main === module) main();

module.exports = { importedProfiles, GREENFIELD_AGENTS };
