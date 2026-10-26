#!/usr/bin/env node

// Merge the latest-mac.yml files from the separate arm64 and x64 macOS builds
// into the single file electron-updater reads. The output matches what one
// two-arch electron-builder run writes: zips before dmgs, arm64 before x64,
// and the top-level path/sha512 taken from the arm64 zip.

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function readUpdateInfo(filePath, arch) {
  const absolutePath = path.resolve(filePath);
  let info;
  try {
    info = yaml.load(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    fail(`Could not read ${arch} latest-mac.yml at ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!info?.version || !Array.isArray(info.files)) {
    fail(`${absolutePath} is missing version or files`);
  }

  for (const ext of ['zip', 'dmg']) {
    const suffix = `-macOS-${arch}.${ext}`;
    const matches = info.files.filter(file => String(file?.url ?? '').endsWith(suffix));
    if (matches.length !== 1 || !matches[0].sha512 || !(matches[0].size > 0)) {
      fail(`${absolutePath} must contain exactly one *${suffix} entry with sha512 and size`);
    }
  }

  if (info.files.length !== 2) {
    fail(`${absolutePath} must list only the ${arch} zip and dmg; found ${info.files.length} files`);
  }

  return info;
}

function main() {
  const [arm64Path, x64Path, outputPath] = process.argv.slice(2);
  if (!arm64Path || !x64Path || !outputPath) {
    console.error('Usage: node scripts/merge-mac-latest.js <arm64-latest-mac.yml> <x64-latest-mac.yml> <output-latest-mac.yml>');
    process.exit(1);
  }

  const arm64 = readUpdateInfo(arm64Path, 'arm64');
  const x64 = readUpdateInfo(x64Path, 'x64');
  if (arm64.version !== x64.version) {
    fail(`Version mismatch: arm64=${arm64.version}, x64=${x64.version}`);
  }

  const byExt = ext => file => file.url.endsWith(`.${ext}`);
  const files = [arm64, x64].flatMap(info => info.files.filter(byExt('zip')))
    .concat([arm64, x64].flatMap(info => info.files.filter(byExt('dmg'))));

  const merged = {
    version: arm64.version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
  };
  if (arm64.releaseDate) {
    merged.releaseDate = arm64.releaseDate;
  }

  const absoluteOutputPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
  fs.writeFileSync(absoluteOutputPath, yaml.dump(merged, { lineWidth: 8000 }), 'utf8');

  console.log(`Merged latest-mac.yml for ${merged.version}:`);
  for (const file of merged.files) {
    console.log(`  - ${file.url} (${file.size} bytes)`);
  }
  console.log(`Wrote ${absoluteOutputPath}`);
}

main();
