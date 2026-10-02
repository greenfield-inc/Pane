import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { boundary, decodeBoundary } from './boundaryDecoder';

const PANE_VERSION_TIMEOUT_MS = 2_000;
const POWERSHELL_TIMEOUT_MS = 2_000;

export function getWrapperVersion(): string {
  // Pane's single-file bundle (main/build-runpane-cli.js) has no package.json
  // beside it; its build replaces this expression with the package version.
  const bundledVersion = process.env.RUNPANE_BUNDLED_VERSION;
  if (bundledVersion) return bundledVersion;
  const packagePath = path.resolve(__dirname, '..', 'package.json');
  try {
    const pkg = decodeBoundary(
      JSON.parse(fs.readFileSync(packagePath, 'utf8')),
      boundary.object({ version: boundary.optional(boundary.string) }),
    );
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function printVersion(_panePath?: string): Promise<number> {
  const wrapperVersion = getWrapperVersion();
  console.log(`runpane ${wrapperVersion}`);
  return 0;
}

export function getPaneVersion(executablePath: string): string | undefined {
  if (process.platform === 'win32') {
    return getWindowsFileVersion(executablePath);
  }
  if (process.platform === 'darwin') {
    return getMacBundleVersion(executablePath);
  }

  return getExecutableVersion(executablePath);
}

function getExecutableVersion(executablePath: string): string | undefined {
  try {
    const result = childProcess.spawnSync(executablePath, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PANE_VERSION_TIMEOUT_MS,
      windowsHide: true
    });
    if (result.error) {
      return undefined;
    }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function getMacBundleVersion(executablePath: string): string | undefined {
  const infoPlistPath = resolveMacInfoPlistPath(executablePath);
  if (!infoPlistPath) {
    return undefined;
  }

  try {
    const plist = fs.readFileSync(infoPlistPath, 'utf8');
    return readPlistString(plist, 'CFBundleShortVersionString')
      ?? readPlistString(plist, 'CFBundleVersion');
  } catch {
    return undefined;
  }
}

function resolveMacInfoPlistPath(executablePath: string): string | undefined {
  const appIndex = executablePath.indexOf('.app');
  if (appIndex === -1) {
    return undefined;
  }

  const appPath = executablePath.slice(0, appIndex + '.app'.length);
  return path.join(appPath, 'Contents', 'Info.plist');
}

function readPlistString(plist: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = plist.match(new RegExp(`<key>\\s*${escapedKey}\\s*<\\/key>\\s*<string>([^<]*)<\\/string>`));
  return match?.[1]?.trim() || undefined;
}

function getWindowsFileVersion(executablePath: string): string | undefined {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$target = $env:RUNPANE_PANE_VERSION_PATH',
    'if (-not $target) { exit 1 }',
    '$info = (Get-Item -LiteralPath $target).VersionInfo',
    'if ($info.FileVersion) { $info.FileVersion } elseif ($info.ProductVersion) { $info.ProductVersion }'
  ].join('; ');

  try {
    const result = childProcess.spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNPANE_PANE_VERSION_PATH: executablePath
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true
    });
    if (result.error) {
      return undefined;
    }
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
