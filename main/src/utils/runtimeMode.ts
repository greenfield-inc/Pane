const HEADLESS_DAEMON_ARGS = new Set([
  '--daemon-headless',
  '--headless-daemon',
]);

const REMOTE_SETUP_ARGS = new Set([
  '--remote-setup',
  '--setup-remote',
]);

export function hasHeadlessDaemonLaunchArg(args = process.argv): boolean {
  return args.some((arg) => HEADLESS_DAEMON_ARGS.has(arg));
}

export function hasRemoteSetupLaunchArg(args = process.argv): boolean {
  return args.some((arg) => REMOTE_SETUP_ARGS.has(arg));
}

export function hasVersionQueryArg(args = process.argv): boolean {
  return args.includes('--version');
}
