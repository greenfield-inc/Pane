#!/usr/bin/env node
// Throwaway side-by-side check: runs ESLint (every rule, overlap removed) and
// Oxlint on the same sources and lists each ESLint finding Oxlint does not report.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packages = [
  { dir: 'main', src: ['src'] },
  { dir: 'frontend', src: ['src'] },
  { dir: 'packages/runpane', src: ['src'] },
  { dir: 'mobile', src: ['src', 'scripts'] },
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result.stdout;
}

const bareName = (rule) => rule.replace(/^@typescript-eslint\//, '').replace(/^[\w-]+\//, '');
const key = (file, line, rule) => `${file}:${line}:${bareName(rule)}`;

const eslint = [];
for (const pkg of packages) {
  const cwd = path.join(root, pkg.dir);
  const bin = path.join(cwd, 'node_modules', '.bin', 'eslint');
  const report = JSON.parse(run(bin, [...pkg.src, '-f', 'json'], cwd));
  for (const file of report) {
    for (const message of file.messages) {
      eslint.push({
        file: path.relative(root, file.filePath),
        line: message.line,
        rule: message.ruleId ?? 'parse-error',
        severity: message.severity === 2 ? 'error' : 'warning',
        message: message.message,
      });
    }
  }
}

const targets = packages.flatMap((pkg) => pkg.src.map((src) => path.join(pkg.dir, src)));
const oxlintBin = path.join(root, 'node_modules', '.bin', 'oxlint');
const oxReport = JSON.parse(run(oxlintBin, ['--config', '.oxlintrc.json', '--format', 'json', ...targets], root));
const oxKeys = new Set();
const oxParseErrors = new Set();
for (const diagnostic of oxReport.diagnostics ?? []) {
  const line = diagnostic.labels?.[0]?.span?.line;
  const rule = diagnostic.code?.match(/^[\w-]+\((.+)\)$/)?.[1];
  if (rule) oxKeys.add(key(diagnostic.filename, line, rule));
  else oxParseErrors.add(diagnostic.filename);
}

const sources = new Map();
const lineOf = (file, line) => {
  if (!sources.has(file)) sources.set(file, readFileSync(path.join(root, file), 'utf8').split('\n'));
  return sources.get(file)[line - 1] ?? '';
};
const oxByFileRule = new Map();
for (const diagnostic of oxReport.diagnostics ?? []) {
  const rule = diagnostic.code?.match(/^[\w-]+\((.+)\)$/)?.[1];
  if (rule) oxByFileRule.set(`${diagnostic.filename}:${rule}`, (oxByFileRule.get(`${diagnostic.filename}:${rule}`) ?? 0) + 1);
}

// Each ESLint finding is reported by Oxlint, suppressed by an oxlint-disable
// comment Oxlint honours and ESLint ignores, or a miss.
const outcome = (finding) => {
  const rule = bareName(finding.rule);
  if (oxKeys.has(key(finding.file, finding.line, finding.rule))) return 'reported';
  if (oxParseErrors.has(finding.file)) return 'reported: Oxlint rejects the file as a parse error';
  if ((oxByFileRule.get(`${finding.file}:${rule}`) ?? 0) > 0) return 'reported on another line of the same file';
  const above = [lineOf(finding.file, finding.line - 1), lineOf(finding.file, finding.line)].join('\n');
  const fileText = sources.get(finding.file).join('\n');
  if (above.includes('oxlint-disable') && above.includes(rule)) return 'suppressed by an oxlint-disable comment';
  if (new RegExp(`oxlint-disable\\s[^\\n]*${rule}`).test(fileText) && !/oxlint-disable-next-line/.test(above)) return 'suppressed by an oxlint-disable comment';
  return 'missed';
};

const byOutcome = new Map();
for (const finding of eslint) {
  const result = outcome(finding);
  byOutcome.set(result, [...(byOutcome.get(result) ?? []), finding]);
}
const matched = eslint.filter((finding) => outcome(finding) !== 'missed');
const missed = byOutcome.get('missed') ?? [];
const rules = (list) => [...new Set(list.map((finding) => finding.rule))].sort();
console.log(`ESLint findings: ${eslint.length} (${rules(eslint).length} rules)`);
for (const [result, list] of byOutcome) console.log(`  ${result}: ${list.length} (${rules(list).length} rules)`);
console.log(`Oxlint findings in the same sources: ${oxReport.diagnostics?.length ?? 0}`);
console.log(`Missed by Oxlint: ${missed.length}`);
for (const finding of missed) {
  console.log(`  MISS ${finding.rule} [${finding.severity}] ${finding.file}:${finding.line} ${finding.message}`);
}
console.log('Matched rules:', rules(matched).join(', '));
