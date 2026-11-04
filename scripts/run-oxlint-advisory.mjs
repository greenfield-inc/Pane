#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oxlintBin = path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint');


const result = spawnSync(
  process.execPath,
  [oxlintBin, '--config', '.oxlintrc.advisory.json', '--format', 'json', '.'],
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
);

if (result.error) {
  console.error(`Advisory Oxlint could not start: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.error(`Advisory Oxlint failed with exit code ${result.status}.`);
  process.exit(result.status ?? 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch (error) {
  if (result.stderr) process.stderr.write(result.stderr);
  console.error(`Advisory Oxlint returned invalid JSON: ${error.message}`);
  process.exit(1);
}

const groups = new Map();
for (const diagnostic of report.diagnostics ?? []) {
  const rule = diagnostic.code?.match(/^anti-slop\((.+)\)$/)?.[1] ?? diagnostic.code ?? 'unknown';
  const group = groups.get(rule) ?? { count: 0, files: new Set() };
  group.count += 1;
  if (diagnostic.filename) group.files.add(diagnostic.filename);
  groups.set(rule, group);
}

let totalFindings = 0;
const allFiles = new Set();
console.log('Advisory anti-slop findings (non-blocking):');
for (const [rule, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
  totalFindings += group.count;
  for (const file of group.files) allFiles.add(file);
  const examples = [...group.files].sort().slice(0, 3).join(', ');
  console.log(`- ${rule}: ${group.count} finding(s) in ${group.files.size} file(s)${examples ? ` — ${examples}` : ''}`);
}

if (groups.size === 0) console.log('- none');
console.log(`Total: ${totalFindings} finding(s) in ${allFiles.size} file(s) across ${groups.size} rule(s).`);
