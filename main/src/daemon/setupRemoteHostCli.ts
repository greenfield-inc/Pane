import {
  formatSetupRemoteHostResult,
  setupRemoteHost,
  type SetupRemoteHostOptions,
} from './setupRemoteHost';
import {
  ensureTailscaleInstalledInteractive,
  runTailscaleUpInteractive,
} from './tailscaleSetup';
import type {
  RemoteSetupChannel,
  RemoteSetupTunnelPreference,
} from '../../../shared/types/remoteDaemon';
import os from 'os';
import path from 'path';
import { repairRemoteDaemonService } from './remoteDaemonService';

export interface RemoteSetupCliDependencies {
  ensureTailscaleInstalledInteractive: typeof ensureTailscaleInstalledInteractive;
  formatSetupRemoteHostResult: typeof formatSetupRemoteHostResult;
  repairRemoteDaemonService: typeof repairRemoteDaemonService;
  runTailscaleUpInteractive: typeof runTailscaleUpInteractive;
  setupRemoteHost: typeof setupRemoteHost;
}

const defaultRemoteSetupCliDependencies: RemoteSetupCliDependencies = {
  ensureTailscaleInstalledInteractive,
  formatSetupRemoteHostResult,
  repairRemoteDaemonService,
  runTailscaleUpInteractive,
  setupRemoteHost,
};

export async function runRemoteSetupCli(
  args = process.argv.slice(2),
  dependencies: RemoteSetupCliDependencies = defaultRemoteSetupCliDependencies,
): Promise<number> {
  try {
    if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
      console.log(getUsageText());
      return 0;
    }

    if (hasFlag(args, '--remote-repair-service')) {
      const paneDir = path.resolve(readArgValue(args, '--pane-dir') ?? path.join(os.homedir(), '.pane_remote'));
      const result = await dependencies.repairRemoteDaemonService(paneDir);
      if (hasFlag(args, '--json')) {
        console.log(JSON.stringify(result));
      } else {
        console.log(result.message);
        console.log(`Launcher: ${result.launcherPath}`);
      }
      return result.ok ? 0 : 1;
    }

    const interactiveTailscaleSetup = hasFlag(args, '--interactive-tailscale-setup');
    const options = parseSetupRemoteHostArgs(args);

    if (interactiveTailscaleSetup) {
      console.log('Pane remote setup: preparing Tailscale...');
      const tailscaleCommand = dependencies.ensureTailscaleInstalledInteractive();
      console.log('Pane remote setup: opening Tailscale login if needed...');
      dependencies.runTailscaleUpInteractive(tailscaleCommand);
      console.log('Pane remote setup: configuring Pane remote daemon...');
    }

    const result = await dependencies.setupRemoteHost({
      ...options,
      interactiveTailscaleSetup,
    });
    console.log(dependencies.formatSetupRemoteHostResult(result));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Pane remote setup failed');
    return 1;
  }
}

function parseSetupRemoteHostArgs(args: string[]): SetupRemoteHostOptions {
  const listenPortValue = readArgValue(args, '--listen-port') ?? readArgValue(args, '--port');
  const channel = parseChannel(readArgValue(args, '--channel'));
  const preferTunnel = parseTunnelPreference(readArgValue(args, '--prefer-tunnel'));

  return {
    paneDir: readArgValue(args, '--pane-dir'),
    label: readArgValue(args, '--label'),
    listenPort: listenPortValue ? Number.parseInt(listenPortValue, 10) : undefined,
    channel,
    repoRef: readArgValue(args, '--repo-ref'),
    baseUrl: readArgValue(args, '--base-url'),
    printOnly: hasFlag(args, '--print-only'),
    autoSelectListenPort: hasFlag(args, '--auto-listen-port'),
    installService: !hasFlag(args, '--no-install-service'),
    exposeTailscale: !hasFlag(args, '--no-tailscale-serve'),
    preferTunnel,
    clientScope: parseClientScope(readArgValue(args, '--client-scope')),
  };
}

function parseClientScope(value: string | undefined): SetupRemoteHostOptions['clientScope'] {
  if (!value) {
    return undefined;
  }

  if (value === 'coordinator') {
    return value;
  }

  throw new Error('--client-scope must be "coordinator"');
}

function parseChannel(value: string | undefined): RemoteSetupChannel | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'stable' || value === 'nightly') {
    return value;
  }

  throw new Error('--channel must be "stable" or "nightly"');
}

function parseTunnelPreference(value: string | undefined): RemoteSetupTunnelPreference | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'auto' || value === 'tailscale' || value === 'ssh' || value === 'manual') {
    return value;
  }

  throw new Error('--prefer-tunnel must be "auto", "tailscale", "ssh", or "manual"');
}

function readArgValue(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
    if (arg === name && index + 1 < args.length) {
      return args[index + 1];
    }
  }

  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function getUsageText(): string {
  return [
    'Pane remote setup',
    '',
    'Usage:',
    '  pane --remote-setup [options]',
    '  pnpm remote:setup -- [options]',
    '',
    'Options:',
    '  --pane-dir <path>             Data directory for the remote daemon (default: ~/.pane_remote)',
    '  --label <name>                Label shown in local Pane after import',
    '  --listen-port <port>          Loopback daemon port (default: 42137)',
    '  --auto-listen-port            If the requested port is busy, use the next available loopback port',
    '  --channel <stable|nightly>    Release channel metadata for website bootstrap validation',
    '  --repo-ref <ref>              Source ref metadata for validation builds',
    '  --base-url <url>              Manual HTTPS base URL when using --prefer-tunnel manual',
    '  --prefer-tunnel <mode>        tailscale, ssh, manual, or legacy auto (default: tailscale)',
    '  --interactive-tailscale-setup Install Tailscale if needed, run tailscale up interactively, then finish setup',
    '  --client-scope coordinator    Pair the Runpane Cloud coordinator: it may only call runpane:cloud:* channels',
    '  --no-install-service          Write config and print manual daemon command without installing startup service',
    '  --no-tailscale-serve          Do not attempt to install or configure Tailscale Serve',
    '  --print-only                  Validate output without writing config, installing service, or configuring tunnels; incompatible with default Tailscale setup',
    '  --remote-repair-service       Internal: repair only the managed launcher and service definition',
    '',
  ].join('\n');
}

if (require.main === module) {
  void runRemoteSetupCli().then((exitCode) => {
    process.exit(exitCode);
  });
}
