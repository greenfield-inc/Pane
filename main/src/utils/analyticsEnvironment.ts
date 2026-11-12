import { readFileSync } from 'fs';
import * as os from 'os';
import type { AnalyticsEnvironment } from '../../../shared/types/analyticsEnvironment';
import { getAppDirectoryOverrideFromArgs } from './appDirectory';

/**
 * The CI variables the runpane wrappers treat as CI
 * (`packages/runpane/src/telemetry.ts`, the pip `telemetry.py`). A test keeps
 * the three lists equal.
 */
export const CI_ENVIRONMENT_KEYS = ['CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'GITLAB_CI', 'CIRCLECI', 'TF_BUILD', 'JENKINS_URL', 'TEAMCITY_VERSION', 'CODEBUILD_BUILD_ID'] as const;

// Most specific first: GitHub and GitLab also set CI.
const CI_PROVIDERS: ReadonlyArray<[key: string, provider: string]> = [
  ['GITHUB_ACTIONS', 'github_actions'],
  ['GITLAB_CI', 'gitlab'],
  ['BUILDKITE', 'buildkite'],
  ['CIRCLECI', 'circleci'],
  ['TF_BUILD', 'azure_pipelines'],
  ['JENKINS_URL', 'jenkins'],
  ['TEAMCITY_VERSION', 'teamcity'],
  ['CODEBUILD_BUILD_ID', 'codebuild'],
];

const CONTAINER_CGROUP = /\/(docker|kubepods|containerd|libpod|lxc)[/.-]/;

export interface EnvironmentProbe {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  osRelease: string;
  /** File contents, or undefined when the file is missing or unreadable. */
  readFile: (path: string) => string | undefined;
  isPackaged: boolean;
  customPaneDir: boolean;
}

function safeRead(probe: EnvironmentProbe, path: string): string | undefined {
  try {
    return probe.readFile(path);
  } catch {
    return undefined;
  }
}

function detectContainer(probe: EnvironmentProbe): boolean {
  if (probe.platform !== 'linux') return false;
  if (safeRead(probe, '/.dockerenv') !== undefined || safeRead(probe, '/run/.containerenv') !== undefined) return true;
  // systemd-nspawn, Podman and LXC set `container`; Flatpak does too, but a
  // Flatpak app is a person's desktop app.
  const marker = probe.env.container;
  if (marker && marker !== 'flatpak') return true;
  return CONTAINER_CGROUP.test(safeRead(probe, '/proc/1/cgroup') ?? '');
}

/**
 * Xvfb is the X server xvfb-run starts; its lock file names its PID. Remote
 * desktops a person uses also run on Xvfb: Xpra names its server
 * `Xvfb-for-Xpra-…`, and Chrome Remote Desktop sets its session variable.
 */
function isVirtualX(probe: EnvironmentProbe, display: string): boolean {
  if (probe.env.CHROME_REMOTE_DESKTOP_SESSION) return false;
  const local = display.match(/^(?:unix)?:(\d+)(?:\.\d+)?$/);
  if (!local) return false;
  const pid = safeRead(probe, `/tmp/.X${local[1]}-lock`)?.trim();
  if (!pid || !/^\d+$/.test(pid)) return false;
  const server = safeRead(probe, `/proc/${pid}/comm`) ?? '';
  return /^Xvfb\b/.test(server) && !server.startsWith('Xvfb-for-Xpra');
}

function detectDisplay(probe: EnvironmentProbe): AnalyticsEnvironment['display'] {
  if (probe.platform !== 'linux') return 'native';
  if (probe.env.WAYLAND_DISPLAY) return 'wayland';
  const x = probe.env.DISPLAY;
  if (!x) return 'none';
  return isVirtualX(probe, x) ? 'virtual' : 'x11';
}

export function detectAnalyticsEnvironment(probe: EnvironmentProbe): AnalyticsEnvironment {
  const ci = CI_ENVIRONMENT_KEYS.some((key) => probe.env[key]);
  const ciProvider = ci ? CI_PROVIDERS.find(([key]) => probe.env[key])?.[1] ?? 'other' : 'none';
  const container = detectContainer(probe);
  const display = detectDisplay(probe);
  const inWsl = probe.platform === 'linux' && (Boolean(probe.env.WSL_DISTRO_NAME) || /microsoft/i.test(probe.osRelease));
  return {
    ci,
    ci_provider: ciProvider,
    container,
    display,
    in_wsl: inWsl,
    packaged: probe.isPackaged,
    custom_pane_dir: probe.customPaneDir,
    automated: ci || display === 'virtual' || display === 'none',
  };
}

let cached: AnalyticsEnvironment | undefined;

/** Detected once per process: none of it changes while Pane runs. */
export function analyticsEnvironment(isPackaged: boolean): AnalyticsEnvironment {
  cached ??= detectAnalyticsEnvironment({
    env: process.env,
    platform: process.platform,
    osRelease: os.release(),
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    isPackaged,
    customPaneDir: Boolean(getAppDirectoryOverrideFromArgs() || process.env.PANE_DIR || process.env.FOOZOL_DIR),
  });
  return cached;
}
