#!/usr/bin/env node
// Fails when source code hard-codes an agent fact: an agent id, executable,
// session mode or minimum version as a string literal ('claude', "cursor-agent",
// 'bypassPermissions', '2.1.316'), or an agent's env var name anywhere
// (env.CODEX_PATH, 'ANTHROPIC_API_KEY'). Agent facts live in
// contracts/runpane/contract.json `agents`, read through shared/agents.ts.
// Files in scripts/agent-names-allowlist.json are exempt up to the number of
// such literals they hold today, each with a reason. A file must hold exactly
// that number: more fails, and fewer fails until the count is lowered, so the
// list only shrinks. Runs in `pnpm lint` (CI) and `pnpm check:fast`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['main/src', 'frontend/src', 'shared', 'native/src', 'packages/runpane/src', 'packages/runpane-py/src'];
const CODE = /\.(?:[cm]?[jt]sx?|py)$/u;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '__tests__', '__pycache__', 'test', 'tests', 'testing']);
const SKIP_FILES = /(?:\.(?:test|spec)\.[^/]+|^test_[^/]+\.py|^generated_contract\.py|^generatedAgents\.ts|^generatedRunpaneContract\.ts)$/u;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#)/u;
const ALLOWLIST_PATH = 'scripts/agent-names-allowlist.json';

const contract = JSON.parse(fs.readFileSync(path.join(root, 'contracts/runpane/contract.json'), 'utf8'));
const ids = Object.keys(contract.agents.entries);
const agents = Object.values(contract.agents.entries);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// Facts matched as a whole quoted literal.
const quoted = [...new Set([
  ...ids,
  ...agents.flatMap((agent) => agent.executables),
  ...agents.flatMap((agent) => [agent.chat?.fullAccess?.mode, ...(agent.chat?.riskyModes ?? []), agent.chat?.minimumVersion]),
].filter(Boolean))];
// Env var names, matched as words anywhere (a property access or a string).
const envNames = [...new Set(agents.flatMap((agent) => [agent.chat?.adapter?.executableEnv, ...(agent.chat?.apiKeyEnv ?? [])]).filter(Boolean))];
const literal = new RegExp(`(['"\`])(?:${quoted.map(escape).join('|')})\\1|\\b(?:${envNames.map(escape).join('|')})\\b`, 'gu');
const allowlist = JSON.parse(fs.readFileSync(path.join(root, ALLOWLIST_PATH), 'utf8'));

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(relative);
    } else if (CODE.test(entry.name) && !SKIP_FILES.test(entry.name)) {
      yield relative;
    }
  }
}

function findLiterals(file) {
  const hits = [];
  fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, index) => {
    if (COMMENT_LINE.test(line)) return;
    for (const match of line.matchAll(literal)) hits.push({ line: index + 1, text: match[0] });
  });
  return hits;
}

const offenders = [];
const stale = [];
const lowered = [];
const seen = new Set();
for (const file of ROOTS.flatMap((dir) => [...walk(dir)])) {
  const hits = findLiterals(file);
  if (file in allowlist) {
    seen.add(file);
    const allowed = allowlist[file].count;
    if (hits.length === 0) stale.push(file);
    else if (hits.length > allowed) offenders.push(...hits.map((hit) => `  ${file}:${hit.line} ${hit.text} (allowlisted for ${allowed}, now ${hits.length})`));
    else if (hits.length < allowed) lowered.push(`  ${file}: ${hits.length} (allowlist says ${allowed})`);
  } else if (hits.length > 0) {
    offenders.push(...hits.map((hit) => `  ${file}:${hit.line} ${hit.text}`));
  }
}
stale.push(...Object.keys(allowlist).filter((file) => !seen.has(file)));

if (offenders.length > 0) {
  console.error(`Agent names found as string literals in ${new Set(offenders.map((line) => line.trim().split(':')[0])).size} files:\n${offenders.join('\n')}\n`
    + 'Agent facts live in the agents config (contracts/runpane/contract.json `agents`, read through shared/agents.ts), so code that names one agent drifts when agents change.\n'
    + `Next: read the fact from shared/agents.ts or the host's agent catalog. If the file is deferred terminal resume or status code, add it to ${ALLOWLIST_PATH} with a reason.`);
}
if (stale.length > 0) {
  console.error(`${ALLOWLIST_PATH} lists files with no agent literal left (or that no longer exist):\n${stale.map((file) => `  ${file}`).join('\n')}\n`
    + 'Next: remove them from the allowlist so it only shrinks.');
}
if (lowered.length > 0) {
  console.error(`These allowlisted files now hold fewer agent literals than ${ALLOWLIST_PATH} allows:\n${lowered.join('\n')}\n`
    + 'Next: lower each file\'s count to the number shown, so no new literal can take the freed place.');
}
if (offenders.length > 0 || stale.length > 0 || lowered.length > 0) process.exit(1);
console.log(`No agent facts hard-coded (${quoted.length + envNames.length} facts from ${ids.length} agents; ${Object.keys(allowlist).length} allowlisted files).`);
