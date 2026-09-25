# Building Pane on Windows

This document explains how to build Pane for Windows.

> **Note:** The primary native modules (`@lydell/node-pty` and `better-sqlite3-multiple-ciphers`) have prebuilt binaries for Windows.

## Quick Start

```bash
# Build for x64 (recommended for most users)
pnpm run build:win:x64

# Build for ARM64
pnpm run build:win:arm64
```

Output files will be in `dist-electron/`:
- `Pane-{version}-Windows-x64.exe` - x64 installer
- `Pane-{version}-Windows-arm64.exe` - ARM64 installer

## Prerequisites

1. **Node.js** - v22.18 or later
2. **pnpm** - v10
3. **Python** - v3.x (for native module compilation)
4. **Visual Studio Build Tools** - With C++ workload

### Installing Visual Studio Build Tools

```bash
# Using winget
winget install Microsoft.VisualStudio.2022.BuildTools

# Or download from:
# https://visualstudio.microsoft.com/visual-cpp-build-tools/
```

Make sure to install the "Desktop development with C++" workload.

## How the Build Works

The Windows build uses a custom script (`scripts/build-win.js`). It:

1. Downloads the Electron prebuilt for `better-sqlite3-multiple-ciphers` for the target architecture.
2. When building for a different architecture than the host, installs the matching `@lydell/node-pty-win32-<arch>` prebuilt package.
3. Builds the frontend and main process, injects build info, and generates notices.
4. Runs electron-builder with native module rebuild disabled.
5. Checks the icons in the packaged app.

### Why These Steps

#### better-sqlite3-multiple-ciphers Electron Prebuilt

**Problem:** When using `pnpm install --ignore-scripts`, the `prebuild-install` postinstall script doesn't run, so the package gets the wrong binary (Node.js ABI instead of Electron ABI). This causes "is not a valid Win32 application" errors at runtime.

**Solution:** The build script runs `prebuild-install` manually with the correct Electron runtime and version to download the Electron-compatible prebuilt binary.

#### Cross-Architecture node-pty

**Problem:** pnpm only installs the `@lydell/node-pty` platform package that matches the host architecture.

**Solution:** For cross-architecture builds, the build script downloads the target platform package and links it into `node_modules`.

#### Native Module Rebuild

**Problem:** Rebuilding native modules for Electron can fail on Windows due to pnpm path issues.

**Solution:** The build script disables npm rebuild (`--config.npmRebuild=false`) and relies on:
- Manually downloaded Electron prebuilts for `better-sqlite3-multiple-ciphers`
- Prebuilt platform packages for `@lydell/node-pty` (no rebuild needed)

## Manual Build Process

If the build script fails, you can try these manual steps:

### Step 1: Install dependencies without running scripts

```bash
pnpm install --ignore-scripts
```

### Step 2: Download Electron prebuilt for better-sqlite3

```bash
# Navigate to the better-sqlite3-multiple-ciphers package directory
cd node_modules/.pnpm/better-sqlite3-multiple-ciphers@*/node_modules/better-sqlite3-multiple-ciphers

# Download the Electron-compatible prebuilt (replace 41.10.3 with your Electron version)
npx prebuild-install --runtime electron --target 41.10.3 --arch x64 --verbose

# Return to project root
cd -
```

### Step 3: Build

```bash
pnpm run build:frontend
pnpm run build:main
pnpm run inject-build-info
pnpm run generate-notices
pnpm exec electron-builder --win --x64 --publish never --config.npmRebuild=false
```

## Troubleshooting

### Error: `node-gyp failed to rebuild`

Try building with `--config.npmRebuild=false` to skip native module rebuild:
```bash
pnpm exec electron-builder --win --x64 --publish never --config.npmRebuild=false
```

### Error: `better_sqlite3.node is not a valid Win32 application`

The better-sqlite3 native module was built for Node.js instead of Electron. Run the prebuild-install step:
```bash
cd node_modules/.pnpm/better-sqlite3-multiple-ciphers@*/node_modules/better-sqlite3-multiple-ciphers
npx prebuild-install --runtime electron --target 41.10.3 --arch x64 --verbose
```

### Native modules not working at runtime

If the app crashes due to native module issues:
1. Ensure you're running on the same architecture you built for
2. Verify the better-sqlite3 prebuilt was downloaded for Electron (see above)
3. Check that Python and Visual Studio Build Tools are properly installed

## Architecture Notes

### x64 vs ARM64

- **x64 build**: Works on both x64 and ARM64 Windows (ARM64 uses emulation)
- **ARM64 build**: Native performance on ARM64, but requires ARM64 native modules

For most users, the x64 build is recommended as it works on all Windows machines.

### Native Module Compatibility

The following native modules are used:
- `better-sqlite3-multiple-ciphers` - SQLite database (has Windows Electron prebuilts)
- `@lydell/node-pty` - Terminal emulation (has Windows x64 prebuilts, validate after each Electron major upgrade)

Both modules have prebuilt binaries that work on Windows without compilation.

## CI/CD

For CI/CD pipelines, use:
```bash
node scripts/build-win.js x64
```

This runs all of the steps above.
