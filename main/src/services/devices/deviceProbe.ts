import { execFile } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

const execFileAsync = promisify(execFile);

const runtimesSchema = boundary.object({ runtimes: boundary.array(boundary.object({ platform: boundary.optional(boundary.string), isAvailable: boundary.optional(boundary.boolean) })) });

interface AndroidReady { ready: true; sdk: string; adb: string; emulator: string; avdmanager?: string }

/** What this machine can run. Probed on the first device call, never at app start. */
export interface DeviceCapabilities {
  ios: { ready: true; xcrun: string } | { ready: false; reason: string };
  android: AndroidReady | { ready: false; reason: string };
  /** simslim (MobAI) on PATH; Pane uses it on its iOS devices when present. */
  simslim?: string;
  npm: boolean;
}

export interface ProbeEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  findExecutable: (name: string) => string | null;
  exists: (file: string) => boolean;
  run: (file: string, args: string[]) => Promise<string>;
}

export function defaultProbeEnvironment(findExecutable: (name: string) => string | null): ProbeEnvironment {
  return {
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
    findExecutable,
    exists: existsSync,
    run: async (file, args) => (await execFileAsync(file, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout,
  };
}

/** The Android SDK folders Pane looks in: ANDROID_HOME, ANDROID_SDK_ROOT, then each OS's default. */
function androidSdkCandidates(environment: Pick<ProbeEnvironment, 'platform' | 'env' | 'home'>): string[] {
  const { platform, env, home } = environment;
  const defaults = platform === 'darwin'
    ? [path.join(home, 'Library', 'Android', 'sdk')]
    : platform === 'win32'
      ? [path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Android', 'Sdk')]
      : [path.join(home, 'Android', 'Sdk'), path.join(home, 'Android', 'sdk')];
  return [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, ...defaults].filter((value): value is string => !!value);
}

export async function probeDevices(environment: ProbeEnvironment): Promise<DeviceCapabilities> {
  const [ios, android] = await Promise.all([probeIos(environment), probeAndroid(environment)]);
  const simslim = environment.platform === 'darwin' ? environment.findExecutable('simslim') ?? undefined : undefined;
  const capabilities: DeviceCapabilities = { ios, android, npm: environment.findExecutable('npm') !== null };
  if (simslim) capabilities.simslim = simslim;
  return capabilities;
}

async function probeIos(environment: ProbeEnvironment): Promise<DeviceCapabilities['ios']> {
  if (environment.platform !== 'darwin') return { ready: false, reason: 'iOS simulators run only on a Mac with Xcode.' };
  const xcrun = environment.findExecutable('xcrun') ?? '/usr/bin/xcrun';
  try {
    const listed = decodeBoundary(JSON.parse(await environment.run(xcrun, ['simctl', 'list', 'runtimes', '--json'])), runtimesSchema);
    const available = listed.runtimes.some(runtime => runtime.platform === 'iOS' && runtime.isAvailable !== false);
    return available ? { ready: true, xcrun } : { ready: false, reason: 'Xcode has no iOS simulator runtime installed. Add one in Xcode > Settings > Components.' };
  } catch {
    return { ready: false, reason: 'Xcode is not installed, or `xcrun simctl` does not work. Install Xcode from the App Store and open it once.' };
  }
}

async function probeAndroid(environment: ProbeEnvironment): Promise<DeviceCapabilities['android']> {
  const exe = environment.platform === 'win32' ? '.exe' : '';
  const bat = environment.platform === 'win32' ? '.bat' : '';
  const sdk = androidSdkCandidates(environment).find(folder => environment.exists(path.join(folder, 'emulator', `emulator${exe}`)));
  if (!sdk) return { ready: false, reason: 'The Android SDK with its emulator is not installed. Install Android Studio, or set ANDROID_HOME to your SDK.' };
  const adb = path.join(sdk, 'platform-tools', `adb${exe}`);
  if (!environment.exists(adb)) return { ready: false, reason: `The Android SDK at ${sdk} has no platform-tools (adb). Install them in Android Studio's SDK Manager.` };
  if (environment.platform === 'linux' && !environment.exists('/dev/kvm')) {
    return { ready: false, reason: 'This Linux machine has no KVM (/dev/kvm), which the Android emulator needs. See https://developer.android.com/studio/run/emulator-acceleration#vm-linux.' };
  }
  const avdmanager = path.join(sdk, 'cmdline-tools', 'latest', 'bin', `avdmanager${bat}`);
  const ready: AndroidReady = { ready: true, sdk, adb, emulator: path.join(sdk, 'emulator', `emulator${exe}`) };
  if (environment.exists(avdmanager)) ready.avdmanager = avdmanager;
  return ready;
}
