#!/usr/bin/env node

/**
 * Verify that a packaged Pane app actually carries the Pane icon.
 *
 * Background: the v2.4.69 Windows build showed the default Electron icon in the
 * taskbar. The bundle icons were fine — Pane.exe's embedded icon group is the
 * Pane logo — but `BrowserWindow({icon})` pointed at
 * `main/dist/main/assets/icon.png`, which no build ever produced, because
 * main's `copy:assets` copied only .sql files. On Windows an unloadable `icon`
 * path is worse than none: Electron sets an empty HICON, which clears the icon
 * the window would otherwise inherit from the executable. macOS hid the bug
 * because it ignores the `icon` option and uses the bundle's .icns.
 *
 * So there are two things to assert, and the runtime one is the one that broke:
 *   1. the runtime window icon ships inside app.asar, and
 *   2. the platform bundle icon (macOS .icns, Windows RT_ICON resources) is the
 *      Pane icon and not Electron's default.
 *
 * Runs from electron-builder's afterPack hook for every platform and target, so
 * a build that loses an icon fails before it can be published. The Windows
 * launcher is the one exception: rcedit writes its icon after that hook, so
 * scripts/build-win.js checks it once electron-builder has finished. Also
 * runnable standalone against an output directory, which is how a published
 * release gets checked:
 *
 *   node scripts/verify-packaged-icon.js [dist-electron-dir]
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const ASSETS_DIR = path.join(ROOT_DIR, 'main', 'assets');
const PRODUCT_NAME = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8')).build.productName;

/** Path of the runtime window icon inside the packaged asar, as index.ts resolves it. */
const RUNTIME_ICON_IN_ASAR = ['main', 'dist', 'main', 'assets', 'icon.png'];

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// --- asar -------------------------------------------------------------------

/**
 * Look one path up in an asar archive's directory tree. An asar is a pickled
 * header — a JSON tree carrying each file's size and SHA-256 — followed by the
 * file contents. The header is enough to check what shipped, and reading it is
 * not sensitive to how the content area is laid out.
 */
function readAsarEntry(asarPath, segments) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizeBuf = Buffer.alloc(16);
    fs.readSync(fd, sizeBuf, 0, 16, 0);
    const headerSize = sizeBuf.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 16);

    let node = JSON.parse(headerBuf.toString('utf8'));
    for (const segment of segments) {
      node = node.files?.[segment];
      if (!node) return null;
    }
    return node.files ? null : node;
  } finally {
    fs.closeSync(fd);
  }
}

// --- Windows PE resources ---------------------------------------------------

/** Parse the RT_ICON (3) and RT_GROUP_ICON (14) resources out of a PE file. */
function readPeIconResources(exePath) {
  const d = fs.readFileSync(exePath);
  const pe = d.readUInt32LE(0x3c);
  if (d.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error(`${exePath} is not a PE file`);

  const sectionCount = d.readUInt16LE(pe + 6);
  const optionalHeaderSize = d.readUInt16LE(pe + 20);
  const optionalHeader = pe + 24;
  const isPe32Plus = d.readUInt16LE(optionalHeader) === 0x20b;
  const dataDirectories = optionalHeader + (isPe32Plus ? 112 : 96);
  const resourceRva = d.readUInt32LE(dataDirectories + 16);

  const sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const s = pe + 24 + optionalHeaderSize + i * 40;
    sections.push({
      virtualSize: d.readUInt32LE(s + 8),
      virtualAddress: d.readUInt32LE(s + 12),
      rawSize: d.readUInt32LE(s + 16),
      rawOffset: d.readUInt32LE(s + 20),
    });
  }
  const toOffset = (rva) => {
    for (const s of sections) {
      const span = Math.max(s.virtualSize, s.rawSize);
      if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
        return s.rawOffset + (rva - s.virtualAddress);
      }
    }
    throw new Error(`RVA ${rva} is outside every section of ${exePath}`);
  };

  const base = toOffset(resourceRva);
  const entriesAt = (offset) => {
    const named = d.readUInt16LE(offset + 12);
    const ids = d.readUInt16LE(offset + 14);
    const out = [];
    for (let i = 0; i < named + ids; i++) {
      const e = offset + 16 + i * 8;
      out.push({ id: d.readUInt32LE(e), offset: d.readUInt32LE(e + 4) });
    }
    return out;
  };

  const icons = new Map();
  const groups = new Map();
  for (const type of entriesAt(base)) {
    const typeId = type.id & 0x7fffffff;
    if ((typeId !== 3 && typeId !== 14) || !(type.offset & 0x80000000)) continue;
    for (const name of entriesAt(base + (type.offset & 0x7fffffff))) {
      for (const lang of entriesAt(base + (name.offset & 0x7fffffff))) {
        const dataEntry = base + lang.offset;
        const start = toOffset(d.readUInt32LE(dataEntry));
        const blob = d.subarray(start, start + d.readUInt32LE(dataEntry + 4));
        (typeId === 3 ? icons : groups).set(name.id & 0x7fffffff, blob);
      }
    }
  }
  return { icons, groups };
}

/** Bitmap payloads of a .ico file, keyed by width. */
function readIcoImages(icoPath) {
  const d = fs.readFileSync(icoPath);
  const images = new Map();
  for (let i = 0; i < d.readUInt16LE(4); i++) {
    const e = 6 + i * 16;
    const width = d.readUInt8(e) || 256;
    const size = d.readUInt32LE(e + 8);
    const offset = d.readUInt32LE(e + 12);
    images.set(width, d.subarray(offset, offset + size));
  }
  return images;
}

// --- checks -----------------------------------------------------------------

function checkRuntimeIcon(asarPath, failures) {
  if (!fs.existsSync(asarPath)) {
    failures.push(`No app.asar at ${asarPath}`);
    return;
  }
  const entry = readAsarEntry(asarPath, RUNTIME_ICON_IN_ASAR);
  const label = RUNTIME_ICON_IN_ASAR.join('/');
  if (!entry) {
    failures.push(
      `${asarPath} does not contain ${label} — BrowserWindow's icon option ` +
        `resolves to a missing file, which leaves the window with no icon on Windows and Linux`
    );
    return;
  }
  const expected = fs.readFileSync(path.join(ASSETS_DIR, 'icon.png'));
  // asar records a SHA-256 per file when integrity is on, which is what Electron
  // itself checks at load. Size is the fallback for an archive built without it.
  const packedHash = entry.integrity?.hash;
  const matches = packedHash ? packedHash === sha256(expected) : entry.size === expected.length;
  if (!matches) {
    failures.push(`${asarPath} ships a ${label} that differs from main/assets/icon.png`);
    return;
  }
  console.log(`[verify-icon] ${path.basename(path.dirname(asarPath))}/app.asar ships the runtime window icon ✓`);
}

function checkMacBundle(appPath, failures) {
  const plistPath = path.join(appPath, 'Contents', 'Info.plist');
  const icnsPath = path.join(appPath, 'Contents', 'Resources', 'icon.icns');
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  const before = failures.length;

  if (!fs.existsSync(icnsPath)) {
    failures.push(`${appPath} has no Contents/Resources/icon.icns — the bundle falls back to Electron's icon`);
  } else if (sha256(fs.readFileSync(icnsPath)) !== sha256(fs.readFileSync(path.join(ASSETS_DIR, 'icon.icns')))) {
    failures.push(`${appPath} ships an icon.icns that differs from main/assets/icon.icns`);
  }

  const plist = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf8') : '';
  if (!/<key>CFBundleIconFile<\/key>\s*<string>icon(\.icns)?<\/string>/.test(plist)) {
    failures.push(`${appPath} does not declare CFBundleIconFile=icon.icns in Info.plist`);
  }

  if (fs.existsSync(asarPath)) {
    const segments = ['main', 'dist', 'main', 'assets', 'icon-macos.png'];
    const entry = readAsarEntry(asarPath, segments);
    const expected = fs.readFileSync(path.join(ASSETS_DIR, 'icon-macos.png'));
    if (!entry || (entry.integrity?.hash ? entry.integrity.hash !== sha256(expected) : entry.size !== expected.length)) {
      failures.push(`${asarPath} is missing the current macOS Dock icon`);
    }
  }

  if (failures.length === before) {
    console.log(`[verify-icon] ${path.basename(appPath)} carries the Pane .icns ✓`);
  }
}

function checkWindowsExe(exePath, failures) {
  let resources;
  try {
    resources = readPeIconResources(exePath);
  } catch (error) {
    failures.push(`Could not read icon resources from ${exePath}: ${error.message}`);
    return;
  }

  if (resources.groups.size === 0) {
    failures.push(`${exePath} has no RT_GROUP_ICON resource — the executable would show Electron's default icon`);
    return;
  }

  const expected = readIcoImages(path.join(ASSETS_DIR, 'icon.ico'));
  const [group] = [...resources.groups.values()];
  const found = new Set();
  // dwBytesInRes in the group directory is not checked: rcedit writes it
  // truncated to 16 bits for the 128px and 256px entries, and has done so in
  // every release including the ones with a correct icon. The payload bytes are
  // what decide which icon Windows draws.
  for (let i = 0; i < group.readUInt16LE(4); i++) {
    const e = 6 + i * 14;
    const width = group.readUInt8(e) || 256;
    const blob = resources.icons.get(group.readUInt16LE(e + 12));
    if (blob && expected.has(width) && Buffer.compare(blob, expected.get(width)) === 0) {
      found.add(width);
    }
  }

  const missing = [...expected.keys()].filter((width) => !found.has(width));
  if (missing.length > 0) {
    failures.push(
      `${exePath} is missing Pane icon bitmaps for: ${missing.join(', ')}px — ` +
        `the executable would show a different icon than main/assets/icon.ico`
    );
    return;
  }
  console.log(`[verify-icon] ${path.basename(exePath)} embeds all ${found.size} Pane icon sizes ✓`);
}

// --- entry points -----------------------------------------------------------

/**
 * Verify one packaged output directory.
 *
 * `checkExecutable` is off for the afterPack hook: on Windows, electron-builder
 * writes the icon into the launcher with rcedit after the hook has run, so the
 * exe still carries Electron's icon at that point. The Windows entry point
 * checks it once electron-builder has finished.
 */
function verifyPackedApp(appOutDir, platform, { checkExecutable = true } = {}) {
  const failures = [];

  if (platform === 'darwin' || platform === 'mas') {
    const bundle = fs
      .readdirSync(appOutDir)
      .filter((entry) => entry.endsWith('.app'))
      .map((entry) => path.join(appOutDir, entry))[0];
    if (!bundle) {
      failures.push(`No .app bundle in ${appOutDir}`);
    } else {
      checkMacBundle(bundle, failures);
      checkRuntimeIcon(path.join(bundle, 'Contents', 'Resources', 'app.asar'), failures);
    }
  } else {
    checkRuntimeIcon(path.join(appOutDir, 'resources', 'app.asar'), failures);
    if (platform === 'win32' && checkExecutable) {
      // The launcher is named after productName; anything else at this level is
      // a helper whose icon nobody sees.
      const exes = fs.readdirSync(appOutDir).filter((entry) => entry.toLowerCase().endsWith('.exe'));
      const name = exes.find((entry) => entry.toLowerCase() === `${PRODUCT_NAME.toLowerCase()}.exe`) ?? exes[0];
      const exe = name ? path.join(appOutDir, name) : null;
      if (!exe) {
        failures.push(`No .exe in ${appOutDir}`);
      } else {
        checkWindowsExe(exe, failures);
      }
    }
  }

  if (failures.length > 0) {
    const message = [`Packaged app in ${appOutDir} is missing its icon:`, ...failures.map((f) => `  - ${f}`)].join('\n');
    throw new Error(message);
  }
}

/** Standalone mode: sweep an output directory for anything worth checking. */
function verifyOutputDir(distDir) {
  if (!fs.existsSync(distDir)) {
    console.error(`[verify-icon] Missing output directory: ${distDir}`);
    process.exit(1);
  }

  const targets = [];
  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(distDir, entry.name);
    if (entry.name.endsWith('.app')) {
      targets.push([path.dirname(full), 'darwin']);
    } else if (fs.readdirSync(full).some((child) => child.endsWith('.app'))) {
      targets.push([full, 'darwin']);
    } else if (fs.existsSync(path.join(full, 'resources', 'app.asar'))) {
      targets.push([full, entry.name.startsWith('win') ? 'win32' : 'linux']);
    }
  }

  if (targets.length === 0) {
    console.error(`[verify-icon] No packaged app found under ${distDir}`);
    process.exit(1);
  }

  let failed = false;
  for (const [dir, platform] of targets) {
    try {
      verifyPackedApp(dir, platform);
    } catch (error) {
      failed = true;
      console.error(`[verify-icon] ${error.message}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  verifyOutputDir(path.resolve(process.argv[2] || path.join(process.cwd(), 'dist-electron')));
}

module.exports = { verifyPackedApp, verifyOutputDir };
