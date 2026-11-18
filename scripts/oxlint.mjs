#!/usr/bin/env node
// Runs Oxlint over the repository in one process per core group. Oxlint runs
// JS plugins (anti-slop) on a single Node thread per process, so one process
// over the whole tree leaves the other cores idle. Extra arguments are passed
// to every process.

import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oxlintBin = path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint');
const shardCount = Math.max(1, Math.min(4, os.availableParallelism()));

// Tracked and untracked files, minus what .gitignore excludes; Oxlint's own
// ignorePatterns still apply inside each path.
const listing = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
if (listing.status !== 0) {
  process.stderr.write(listing.stderr);
  console.error('Oxlint could not list the repository files with git ls-files.');
  process.exit(1);
}
const files = listing.stdout.split('\0').filter((file) => /\.(?:[cm]?[jt]sx?)$/.test(file));

// Split the tree into path groups no larger than a share of the files, so the
// groups cover every file once and can be packed into shards of similar size.
const limit = Math.ceil(files.length / (shardCount * 4));
function groups(prefix, members) {
  if (members.length <= limit) return [{ path: prefix || '.', size: members.length }];
  const children = new Map();
  for (const file of members) {
    const rest = file.slice(prefix ? prefix.length + 1 : 0);
    const slash = rest.indexOf('/');
    const child = slash === -1 ? file : `${prefix ? `${prefix}/` : ''}${rest.slice(0, slash)}`;
    children.set(child, [...(children.get(child) ?? []), file]);
  }
  return [...children].flatMap(([child, childFiles]) =>
    childFiles.length === 1 && childFiles[0] === child
      ? [{ path: child, size: 1 }]
      : groups(child, childFiles),
  );
}

const shards = Array.from({ length: shardCount }, () => ({ paths: [], size: 0 }));
for (const group of groups('', files).sort((left, right) => right.size - left.size)) {
  const smallest = shards.reduce((best, shard) => (shard.size < best.size ? shard : best));
  smallest.paths.push(group.path);
  smallest.size += group.size;
}

const runs = shards
  .filter((shard) => shard.paths.length > 0)
  .map(
    (shard) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          // A shard may hold only ignored paths (native/), which is not an error.
          [oxlintBin, '--config', '.oxlintrc.json', '--no-error-on-unmatched-pattern', ...process.argv.slice(2), ...shard.paths],
          { cwd: repoRoot },
        );
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        child.on('error', (error) => resolve({ output: `${output}Oxlint could not start: ${error.message}\n`, status: 1 }));
        child.on('close', (status) => resolve({ output, status: status ?? 1 }));
      }),
  );

// exitCode, not exit(): exiting would cut off output still queued for a pipe.
for (const run of await Promise.all(runs)) {
  process.stdout.write(run.output);
  if (run.status !== 0) process.exitCode = run.status;
}
