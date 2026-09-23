#!/usr/bin/env node
/**
 * Release script for Pane
 *
 * This script can be run from any clean worktree whose HEAD matches
 * origin/main. It creates a release commit, tags it, pushes the commit to
 * main explicitly, then pushes the tag.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const versionedPackageFiles = [
  'package.json',
  'packages/runpane/package.json',
  'packages/runpane-py/pyproject.toml',
  'packages/runpane-py/src/runpane/__init__.py',
];

function run(command, options = {}) {
  const result = execSync(command, {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  });
  return result ? result.trim() : '';
}

function getGitStatus() {
  return run('git status --porcelain');
}

function getHeadPackageVersion() {
  try {
    const headPackageJson = run('git show HEAD:package.json');
    return JSON.parse(headPackageJson).version;
  } catch {
    console.error('Unable to read package.json from HEAD. Aborting before tag.');
    process.exit(1);
  }
}

function getHeadFile(filePath) {
  try {
    return run(`git show HEAD:${filePath}`);
  } catch {
    console.error(`Unable to read ${filePath} from HEAD. Aborting before tag.`);
    process.exit(1);
  }
}

function verifyHeadPackageVersions(expectedVersion) {
  const rootPackage = JSON.parse(getHeadFile('package.json'));
  const npmPackage = JSON.parse(getHeadFile('packages/runpane/package.json'));
  const pyproject = getHeadFile('packages/runpane-py/pyproject.toml');
  const pyInit = getHeadFile('packages/runpane-py/src/runpane/__init__.py');

  const pyprojectMatch = /^version = "([^"]+)"/m.exec(pyproject);
  const pyInitMatch = /^__version__ = "([^"]+)"/m.exec(pyInit);
  const versions = {
    'package.json': rootPackage.version,
    'packages/runpane/package.json': npmPackage.version,
    'packages/runpane-py/pyproject.toml': pyprojectMatch?.[1],
    'packages/runpane-py/src/runpane/__init__.py': pyInitMatch?.[1],
  };

  const mismatches = Object.entries(versions)
    .filter(([, version]) => version !== expectedVersion)
    .map(([filePath, version]) => `${filePath}: ${version || 'missing'}`);

  if (mismatches.length > 0) {
    console.error(`HEAD package versions are not all ${expectedVersion}. Aborting before tag.`);
    mismatches.forEach((mismatch) => console.error(`  ${mismatch}`));
    process.exit(1);
  }
}

function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) {
    return null;
  }

  return match.slice(1).map(Number);
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }

  return 0;
}

function formatSemver(parts) {
  return parts.join('.');
}

function getLatestReleaseTag() {
  const tagOutput = run('git tag --list "v[0-9]*.[0-9]*.[0-9]*"');
  const parsedTags = tagOutput
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => ({ tag, version: parseSemver(tag) }))
    .filter((entry) => entry.version);

  if (parsedTags.length === 0) {
    return null;
  }

  parsedTags.sort((a, b) => compareSemver(b.version, a.version));
  return parsedTags[0];
}

function incrementVersion(version, bump) {
  const parts = parseSemver(version);
  if (!parts) {
    console.error(`Invalid package.json version: ${version}`);
    process.exit(1);
  }

  if (bump === 'patch') {
    parts[2]++;
  } else if (bump === 'minor') {
    parts[1]++;
    parts[2] = 0;
  } else if (bump === 'major') {
    parts[0]++;
    parts[1] = 0;
    parts[2] = 0;
  }

  return formatSemver(parts);
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node scripts/release.js <patch|minor|major|version>');
  console.error('Examples:');
  console.error('  node scripts/release.js patch   # 0.0.2 -> 0.0.3');
  console.error('  node scripts/release.js minor   # 0.0.2 -> 0.1.0');
  console.error('  node scripts/release.js major   # 0.0.2 -> 1.0.0');
  console.error('  node scripts/release.js 0.1.0   # explicit version');
  process.exit(1);
}

const status = getGitStatus();
if (status) {
  console.error('Release requires a clean worktree. Commit or stash changes first.');
  console.error(status);
  process.exit(1);
}

run('git fetch origin main --tags', { stdio: 'inherit' });
const head = run('git rev-parse HEAD');
const originMain = run('git rev-parse origin/main');
if (head !== originMain) {
  console.error('Release HEAD must match origin/main.');
  console.error(`HEAD:        ${head}`);
  console.error(`origin/main: ${originMain}`);
  console.error('Update this worktree to origin/main or create a clean temp worktree from origin/main.');
  process.exit(1);
}

const latestRelease = getLatestReleaseTag();
const latestVersion = latestRelease ? formatSemver(latestRelease.version) : null;
let cleanVersion;

if (['patch', 'minor', 'major'].includes(input)) {
  if (!latestRelease) {
    console.error(`Cannot infer a ${input} release because no v* semver tags exist.`);
    console.error('Use an explicit version, for example: pnpm run release 1.0.0');
    process.exit(1);
  }

  if (pkg.version !== latestVersion) {
    console.error(`Cannot infer a ${input} release because package.json and the latest release tag disagree.`);
    console.error(`package.json: ${pkg.version}`);
    console.error(`latest tag:   ${latestRelease.tag}`);
    console.error('Use an explicit version after deciding the intended next release, for example:');
    console.error(`  pnpm run release ${latestVersion.split('.').slice(0, 2).join('.')}.${latestRelease.version[2] + 1}`);
    process.exit(1);
  }

  cleanVersion = incrementVersion(pkg.version, input);
} else {
  cleanVersion = input.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(cleanVersion)) {
    console.error(`Invalid version format: ${cleanVersion}`);
    process.exit(1);
  }

  const requestedVersion = parseSemver(cleanVersion);
  if (latestRelease && compareSemver(requestedVersion, latestRelease.version) <= 0) {
    console.error(`Requested release v${cleanVersion} must be newer than latest tag ${latestRelease.tag}.`);
    process.exit(1);
  }
}

console.log(`Releasing v${cleanVersion} (was ${pkg.version})...`);
if (latestRelease) {
  console.log(`Latest release tag: ${latestRelease.tag}`);
}

const tagName = `v${cleanVersion}`;
try {
  run(`git rev-parse --verify refs/tags/${tagName}`);
  console.error(`Tag ${tagName} already exists locally.`);
  process.exit(1);
} catch {
  // Tag does not exist locally.
}
try {
  run(`git ls-remote --exit-code --tags origin ${tagName}`);
  console.error(`Tag ${tagName} already exists on origin.`);
  process.exit(1);
} catch {
  // Tag does not exist remotely.
}

// Update version metadata for the desktop app and wrapper packages.
run(`node scripts/sync-runpane-package-versions.js ${cleanVersion}`, { stdio: 'inherit' });

// Commit, tag, push
run(`git add ${versionedPackageFiles.join(' ')}`, { stdio: 'inherit' });
try {
  run(`git commit -m "release: v${cleanVersion}"`, { stdio: 'inherit' });
} catch {
  const postCommitStatus = getGitStatus();
  if (postCommitStatus) {
    console.error('Release commit failed while changes remain in the worktree. Aborting before tag.');
    console.error('Fix the commit failure, restore the worktree, and rerun the release.');
    console.error(postCommitStatus);
    process.exit(1);
  }

  console.log('No version change to commit, continuing with tag...');
}

const headPackageVersion = getHeadPackageVersion();
if (headPackageVersion !== cleanVersion) {
  console.error(`HEAD package.json version is ${headPackageVersion}, expected ${cleanVersion}. Aborting before tag.`);
  console.error('The release tag must point at a commit that contains the released package.json version.');
  process.exit(1);
}
verifyHeadPackageVersions(cleanVersion);
run(`git tag ${tagName}`, { stdio: 'inherit' });
run('git push origin HEAD:main', { stdio: 'inherit' });
run(`git push origin ${tagName}`, { stdio: 'inherit' });

console.log(`\nRelease v${cleanVersion} triggered!`);
console.log('Watch progress at: https://github.com/greenfield-inc/Pane/actions');
