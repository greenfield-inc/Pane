#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const checkMode = args[0] === '--check';
const requestedVersion = checkMode ? undefined : args[0];

if (!checkMode && (!requestedVersion || !/^\d+\.\d+\.\d+$/.test(requestedVersion))) {
  console.error('Usage: node scripts/sync-runpane-package-versions.js <x.y.z>');
  console.error('   or: node scripts/sync-runpane-package-versions.js --check');
  process.exit(1);
}

const files = {
  rootPackage: path.join(rootDir, 'package.json'),
  npmPackage: path.join(rootDir, 'packages', 'runpane', 'package.json'),
  // The MCP Registry entry names the npm release it runs.
  serverJson: path.join(rootDir, 'packages', 'runpane', 'server.json'),
  pyproject: path.join(rootDir, 'packages', 'runpane-py', 'pyproject.toml'),
  pyInit: path.join(rootDir, 'packages', 'runpane-py', 'src', 'runpane', '__init__.py')
};

function readJsonVersion(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')).version;
}

function readVersionOrFail(filePath, pattern) {
  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(pattern);
  if (!match) {
    throw new Error(`Could not read version in ${path.relative(rootDir, filePath)}`);
  }
  return match[1];
}

function updateJsonVersion(filePath) {
  const pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  pkg.version = requestedVersion;
  fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + '\n');
}

function updateServerJsonVersion(filePath) {
  const server = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  server.version = requestedVersion;
  for (const pkg of server.packages) pkg.version = requestedVersion;
  fs.writeFileSync(filePath, JSON.stringify(server, null, 2) + '\n');
}

function replaceOrFail(filePath, pattern, replacement) {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!pattern.test(content)) {
    throw new Error(`Could not update version in ${path.relative(rootDir, filePath)}`);
  }
  const next = content.replace(pattern, replacement);
  fs.writeFileSync(filePath, next);
}

function checkVersions() {
  const versions = {
    'package.json': readJsonVersion(files.rootPackage),
    'packages/runpane/package.json': readJsonVersion(files.npmPackage),
    'packages/runpane/server.json': readJsonVersion(files.serverJson),
    'packages/runpane/server.json packages[0]': JSON.parse(fs.readFileSync(files.serverJson, 'utf8')).packages[0].version,
    'packages/runpane-py/pyproject.toml': readVersionOrFail(files.pyproject, /^version = "([^"]+)"/m),
    'packages/runpane-py/src/runpane/__init__.py': readVersionOrFail(files.pyInit, /^__version__ = "([^"]+)"/m)
  };
  const expected = versions['package.json'];
  const mismatches = Object.entries(versions).filter(([, value]) => value !== expected);

  if (mismatches.length > 0) {
    console.error(`runpane package versions are out of sync with package.json (${expected}):`);
    for (const [filePath, value] of mismatches) {
      console.error(`  ${filePath}: ${value}`);
    }
    process.exit(1);
  }

  console.log(`runpane package versions are in sync at ${expected}`);
}

try {
  if (checkMode) {
    checkVersions();
  } else {
    updateJsonVersion(files.rootPackage);
    updateJsonVersion(files.npmPackage);
    updateServerJsonVersion(files.serverJson);
    replaceOrFail(files.pyproject, /^version = "[^"]+"/m, `version = "${requestedVersion}"`);
    replaceOrFail(files.pyInit, /^__version__ = "[^"]+"/m, `__version__ = "${requestedVersion}"`);
    console.log(`Synced runpane package versions to ${requestedVersion}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
