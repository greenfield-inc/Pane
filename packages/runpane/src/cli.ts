#!/usr/bin/env node
import * as os from 'node:os';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { runAgentContext } from './agentContext';
import { helpText, parseRunpaneArgs, type ParsedArgs } from './commands';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { downloadArtifact } from './download';
import { runDoctor } from './doctor';
import {
  installPaneArtifact,
  launchPaneClient,
  resolveExistingPanePath,
  shouldReuseExistingPane,
  spawnPane,
  spawnPaneCaptured
} from './installers';
import {
  runAgentsDoctor,
  runPanelsCreate,
  runPanelsInput,
  runPanelsList,
  runPanelsOutput,
  runPanelsScreen,
  runPanelsSubmit,
  runPanelsSubmitComposer,
  runPanelsWait,
  runPanesArchive,
  runPanesAdopt,
  runPanesHandoff,
  runPanesReceive,
  runPanesCreate,
  runPanesCost,
  runPanesList,
  runPanesPin,
  runPanesRename,
  runPanesFocus,
  runSessionsAssociate,
  runSessionsCreate,
  runSessionsDetach,
  runSessionsGet,
  runSessionsList,
  runSessionsOverview,
  runSessionsSetAgent,
  runSessionsUpdate,
  runReposAdd,
  runReposList,
  runWatch,
  runWorkspaceState
} from './localControl';
import { detectPlatform } from './platform';
import { resolveRelease } from './releases';
import {
  applyParsedArgsToTelemetryContext,
  categorizeFailure,
  createInitialTelemetryContext,
  setSetupSelection,
  trackWrapperEvent,
  type WrapperTelemetryContext
} from './telemetry';
import { printVersion } from './version';

const SOURCE = 'npm' as const;

export async function main(argv: string[]): Promise<number> {
  const telemetryContext = createInitialTelemetryContext(argv);
  if (argv.length === 0) {
    return runTrackedCommand(telemetryContext, () => runNoArgsEntrypoint(telemetryContext));
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseRunpaneArgs(argv);
  } catch (error) {
    telemetryContext.failureStage = 'parse';
    telemetryContext.failureCategory = categorizeFailure(error);
    await trackWrapperEvent('runpane_wrapper_command_failed', telemetryContext);
    if (argv[0] === 'watch') {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const line = `WATCH ERROR ${normalized.name || 'Error'}: ${normalized.message}`;
      process.stdout.write(`${line}\n`);
      process.stderr.write(`${line}\n`);
      return 2;
    }
    throw error;
  }
  applyParsedArgsToTelemetryContext(telemetryContext, parsed);

  if (parsed.command === 'version') {
    return dispatchParsedCommand(parsed, telemetryContext);
  }

  return runTrackedCommand(telemetryContext, () => dispatchParsedCommand(parsed, telemetryContext));
}

async function dispatchParsedCommand(parsed: ParsedArgs, telemetryContext: WrapperTelemetryContext): Promise<number> {
  if (parsed.command === 'help') {
    console.log(helpText(parsed.helpTopic));
    return 0;
  }

  if (parsed.command === 'setup') {
    return runNoArgsEntrypoint(telemetryContext);
  }

  if (parsed.command === 'version') {
    return printVersion(parsed.panePath);
  }

  if (parsed.command === 'doctor') {
    return runDoctor(parsed, SOURCE);
  }

  if (parsed.command === 'daemon repair') {
    return runDaemonRepair(parsed);
  }

  if (parsed.command === 'agent-context') {
    return runAgentContext(parsed);
  }

  if (parsed.command === 'repos list') {
    return runReposList(parsed);
  }

  if (parsed.command === 'repos add') {
    return runReposAdd(parsed);
  }

  if (parsed.command === 'panes list') {
    return runPanesList(parsed);
  }

  if (parsed.command === 'panes cost') {
    return runPanesCost(parsed);
  }

  if (parsed.command === 'sessions list') {
    return runSessionsList(parsed);
  }

  if (parsed.command === 'sessions create') {
    return runSessionsCreate(parsed);
  }

  if (parsed.command === 'sessions get') {
    return runSessionsGet(parsed);
  }

  if (parsed.command === 'sessions update') {
    return runSessionsUpdate(parsed);
  }

  if (parsed.command === 'sessions set-agent') {
    return runSessionsSetAgent(parsed);
  }

  if (parsed.command === 'sessions associate') {
    return runSessionsAssociate(parsed);
  }

  if (parsed.command === 'sessions detach') {
    return runSessionsDetach(parsed);
  }

  if (parsed.command === 'sessions overview') {
    return runSessionsOverview(parsed);
  }

  if (parsed.command === 'workspace state') {
    return runWorkspaceState(parsed);
  }

  if (parsed.command === 'watch') {
    return runWatch(parsed);
  }

  if (parsed.command === 'panes create') {
    return runPanesCreate(parsed);
  }

  if (parsed.command === 'panes adopt') {
    return runPanesAdopt(parsed);
  }

  if (parsed.command === 'panes archive') {
    return runPanesArchive(parsed);
  }

  if (parsed.command === 'panes handoff') {
    return runPanesHandoff(parsed);
  }

  if (parsed.command === 'panes receive') {
    return runPanesReceive(parsed);
  }

  if (parsed.command === 'panes pin') {
    return runPanesPin(parsed, true);
  }

  if (parsed.command === 'panes unpin') {
    return runPanesPin(parsed, false);
  }

  if (parsed.command === 'panes rename') {
    return runPanesRename(parsed);
  }

  if (parsed.command === 'panes focus') {
    return runPanesFocus(parsed);
  }

  if (parsed.command === 'panels list') {
    return runPanelsList(parsed);
  }

  if (parsed.command === 'panels create') {
    return runPanelsCreate(parsed);
  }

  if (parsed.command === 'panels output') {
    return runPanelsOutput(parsed);
  }

  if (parsed.command === 'panels input') {
    return runPanelsInput(parsed);
  }

  if (parsed.command === 'panels screen') {
    return runPanelsScreen(parsed);
  }

  if (parsed.command === 'panels submit') {
    return runPanelsSubmit(parsed);
  }

  if (parsed.command === 'panels submit-composer') {
    return runPanelsSubmitComposer(parsed);
  }

  if (parsed.command === 'panels wait') {
    return runPanelsWait(parsed);
  }

  if (parsed.command === 'agents doctor') {
    return runAgentsDoctor(parsed);
  }

  if (parsed.command === 'install' || parsed.command === 'update') {
    return installOrUpdate(parsed, telemetryContext);
  }

  console.log(helpText());
  return 0;
}

const daemonRepairResultSchema = boundary.object({
  ok: boundary.boolean,
  changed: boundary.boolean,
  paneDir: boundary.string,
  strategy: boundary.enumeration('systemd-user', 'launch-agent', 'scheduled-task', 'manual', 'skipped'),
  launcherPath: boundary.string,
  before: boundary.jsonObject,
  after: boundary.jsonObject,
  message: boundary.string,
});

async function runDaemonRepair(parsed: ParsedArgs): Promise<number> {
  const executable = resolveExistingPanePath(parsed.panePath);
  if (!executable) {
    throw new Error('Pane is not installed. Install Pane first, then rerun runpane daemon repair.');
  }
  await confirmDaemonRepair(parsed);
  const paneDir = parsed.paneDir ?? `${os.homedir()}/.pane_remote`;
  const args = ['--remote-setup', '--remote-repair-service', '--pane-dir', paneDir];
  if (parsed.json) {
    const child = await spawnPaneCaptured(executable, [...args, '--json']);
    try {
      const result = decodeBoundary(JSON.parse(child.stdout.trim()), daemonRepairResultSchema);
      console.log(JSON.stringify(result, null, 2));
      return child.code === 0 && result.ok ? 0 : 1;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      throw new Error(`Pane returned an invalid daemon repair result: ${child.stderr.trim() || failure.message}`);
    }
  }
  console.log(`runpane: repairing the remote daemon service in ${paneDir}...`);
  return spawnPane(executable, args);
}

async function confirmDaemonRepair(parsed: ParsedArgs): Promise<void> {
  if (parsed.yes) return;
  if (parsed.json || !input.isTTY || !output.isTTY) {
    throw new Error('runpane daemon repair restarts the remote daemon service. Rerun with --yes to confirm.');
  }
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question('Repair and restart the Pane remote daemon service? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      throw new Error('Daemon repair cancelled.');
    }
  } finally {
    rl.close();
  }
}

async function runTrackedCommand(
  telemetryContext: WrapperTelemetryContext,
  execute: () => Promise<number>
): Promise<number> {
  await trackWrapperEvent('runpane_wrapper_command_started', telemetryContext);
  try {
    const code = await execute();
    telemetryContext.exitCode = code;
    if (code === 0) {
      await trackWrapperEvent('runpane_wrapper_command_succeeded', telemetryContext);
    } else {
      telemetryContext.failureStage ??= inferFailureStage(telemetryContext);
      telemetryContext.failureCategory ??= 'process_exit';
      await trackWrapperEvent('runpane_wrapper_command_failed', telemetryContext);
    }
    return code;
  } catch (error) {
    telemetryContext.failureStage ??= 'unknown';
    telemetryContext.failureCategory ??= categorizeFailure(error);
    await trackWrapperEvent('runpane_wrapper_command_failed', telemetryContext);
    throw error;
  }
}

function inferFailureStage(telemetryContext: WrapperTelemetryContext): WrapperTelemetryContext['failureStage'] {
  if (telemetryContext.resolvedCommand === 'install' && telemetryContext.target === 'daemon') {
    return 'remote_setup';
  }
  return 'unknown';
}

async function runNoArgsEntrypoint(telemetryContext: WrapperTelemetryContext): Promise<number> {
  if (!isInteractiveShell()) {
    telemetryContext.resolvedCommand = 'help';
    console.log(helpText());
    return 0;
  }

  return runInteractiveWizard(telemetryContext);
}

function isInteractiveShell(): boolean {
  return Boolean(input.isTTY && output.isTTY && !process.env.CI);
}

async function runInteractiveWizard(telemetryContext: WrapperTelemetryContext): Promise<number> {
  const rl = createInterface({ input, output });

  try {
    console.log('Pane setup');
    console.log('Choose what this machine should do. You can rerun setup any time.');
    console.log('Commands: runpane help, runpane doctor, runpane doctor --json, runpane agent-context --json');
    console.log('');
    console.log('1) Install Pane desktop app on this machine');
    console.log('2) Set up this machine as a remote host');
    console.log('3) Update Pane desktop app');
    console.log('4) Run diagnostics');
    console.log('');

    const action = await askChoice(rl, 'Choose an action [1]: ', {
      '': 'client',
      '1': 'client',
      client: 'client',
      install: 'client',
      desktop: 'client',
      '2': 'daemon',
      daemon: 'daemon',
      remote: 'daemon',
      host: 'daemon',
      '3': 'update',
      update: 'update',
      '4': 'doctor',
      doctor: 'doctor',
      diagnostics: 'doctor'
    });

    if (action === 'client') {
      console.log('');
      console.log('Installing Pane desktop app on this machine...');
      setSetupSelection(telemetryContext, 'install', 'client');
      return installOrUpdate(createParsedArgs('install', { target: 'client' }), telemetryContext);
    }

    if (action === 'update') {
      console.log('');
      console.log('Updating Pane desktop app on this machine...');
      setSetupSelection(telemetryContext, 'update', 'client');
      return installOrUpdate(createParsedArgs('update', { target: 'client' }), telemetryContext);
    }

    if (action === 'doctor') {
      console.log('');
      console.log('Running runpane diagnostics...');
      setSetupSelection(telemetryContext, 'doctor');
      return runDoctor(createParsedArgs('doctor'), SOURCE);
    }

    console.log('');
    console.log('A remote host runs your repos, terminals, agents, and git state.');
    console.log('Your desktop Pane or browser client connects with the generated pane-remote:// code.');

    const defaultLabel = os.hostname() || 'Remote Host';
    const label = (await rl.question(`Remote host label [${defaultLabel}]: `)).trim() || defaultLabel;

    console.log('');
    console.log('Connection method:');
    console.log('1) auto');
    console.log('2) tailscale');
    console.log('3) ssh');
    console.log('4) manual');
    console.log('');
    console.log('Use auto unless you already know you want Tailscale, SSH, or a manual URL.');
    console.log('');

    const tunnel = await askChoice(rl, 'Choose a connection method [1]: ', {
      '': 'auto',
      '1': 'auto',
      auto: 'auto',
      '2': 'tailscale',
      tailscale: 'tailscale',
      '3': 'ssh',
      ssh: 'ssh',
      '4': 'manual',
      manual: 'manual'
    });

    const remoteSetupArgs = ['--label', label];
    if (tunnel !== 'auto') {
      remoteSetupArgs.push('--prefer-tunnel', tunnel);
    }

    console.log('');
    console.log('Setting up this machine as a Pane remote host...');
    console.log('When setup finishes, paste the printed pane-remote:// code into Pane or runpane.com/app.');

    setSetupSelection(telemetryContext, 'install', 'daemon');
    return installOrUpdate(createParsedArgs('install', {
      target: 'daemon',
      remoteSetupArgs
    }), telemetryContext);
  } finally {
    rl.close();
  }
}

async function askChoice<T extends string>(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  choices: Record<string, T>
): Promise<T> {
  while (true) {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    const choice = choices[answer];
    if (choice) {
      return choice;
    }
    console.log(`Choose one of: ${Object.keys(choices).filter(Boolean).join(', ')}`);
  }
}

function createParsedArgs(command: ParsedArgs['command'], overrides: Partial<ParsedArgs> = {}): ParsedArgs {
  return {
    command,
    target: 'client',
    paneVersion: 'latest',
    channel: 'stable',
    format: 'auto',
    dryRun: false,
    yes: false,
    verbose: false,
    json: false,
    remoteSetupArgs: [],
    ...overrides
  };
}

export async function installOrUpdate(parsed: ParsedArgs, telemetryContext?: WrapperTelemetryContext): Promise<number> {
  const target = parsed.command === 'update' ? 'client' : parsed.target;
  const context = telemetryContext ?? createInstallTelemetryContext(parsed, target);
  context.target = target;
  context.paneVersion = parsed.paneVersion;
  context.channel = parsed.channel;
  context.format = parsed.format;
  context.dryRun = parsed.dryRun;
  if (!parsed.dryRun && shouldReuseExistingPane(parsed, target)) {
    const existing = resolveExistingPanePath(parsed.panePath);
    if (existing) {
      console.log(`runpane: using existing Pane executable at ${existing}`);
      console.log('runpane: starting remote setup...');
      context.installKind = 'existing';
      const code = await spawnPane(existing, ['--remote-setup', ...parsed.remoteSetupArgs]);
      context.exitCode = code;
      if (code !== 0) {
        context.failureStage = 'remote_setup';
        context.failureCategory = 'process_exit';
      }
      return code;
    }
  }

  let platform: ReturnType<typeof detectPlatform>;
  try {
    platform = detectPlatform();
    context.platform = platform;
  } catch (error) {
    context.failureStage = 'resolve_release';
    context.failureCategory = categorizeFailure(error);
    throw error;
  }
  console.log(`runpane: resolving Pane release ${parsed.paneVersion}...`);
  let resolved: Awaited<ReturnType<typeof resolveRelease>>;
  try {
    resolved = await resolveRelease({
      version: parsed.paneVersion,
      channel: parsed.channel,
      source: SOURCE,
      platform,
      format: parsed.format,
      target
    });
    context.resolvedFormat = resolved.format;
  } catch (error) {
    context.failureStage = 'resolve_release';
    context.failureCategory = categorizeFailure(error);
    throw error;
  }

  if (parsed.dryRun) {
    printDryRun(parsed, resolved.artifact.name, resolved.preferredDownloadUrl, resolved.fallbackDownloadUrl);
    return 0;
  }

  console.log(`runpane: selected ${resolved.artifact.name}`);
  console.log(`runpane: downloading ${resolved.artifact.name}...`);
  await trackWrapperEvent('runpane_wrapper_download_requested', context);
  let artifact: Awaited<ReturnType<typeof downloadArtifact>>;
  try {
    artifact = await downloadArtifact(resolved, parsed.downloadDir, parsed.verbose, async (error) => {
      await trackWrapperEvent('runpane_wrapper_github_fallback_used', {
        ...context,
        usedFallback: true,
        failureStage: 'download',
        failureCategory: categorizeFailure(error),
      });
    });
    context.usedFallback = artifact.usedFallback;
    await trackWrapperEvent('runpane_wrapper_download_succeeded', context);
  } catch (error) {
    const failureCategory = categorizeFailure(error);
    context.failureStage = failureCategory === 'checksum' ? 'checksum' : 'download';
    context.failureCategory = failureCategory;
    await trackWrapperEvent('runpane_wrapper_download_failed', context);
    throw error;
  }
  console.log(`runpane: downloaded ${artifact.fileName}${artifact.usedFallback ? ' from GitHub fallback' : ''}`);
  console.log('runpane: installing Pane...');
  let installed: Awaited<ReturnType<typeof installPaneArtifact>>;
  try {
    installed = await installPaneArtifact(artifact, {
      parsed,
      platform,
      format: resolved.format,
      target
    });
    context.installKind = installed.installKind;
  } catch (error) {
    context.failureStage = 'install';
    context.failureCategory = categorizeFailure(error);
    throw error;
  }

  if (target === 'daemon') {
    console.log('runpane: starting remote setup...');
    const code = await spawnPane(installed.executablePath, ['--remote-setup', ...parsed.remoteSetupArgs]);
    context.exitCode = code;
    if (code !== 0) {
      context.failureStage = 'remote_setup';
      context.failureCategory = 'process_exit';
    }
    return code;
  }

  if (installed.installKind === 'installed') {
    try {
      launchPaneClient(installed.executablePath);
    } catch (error) {
      context.failureStage = 'launch';
      context.failureCategory = categorizeFailure(error);
      throw error;
    }
  }

  console.log(`Pane ${installed.installKind === 'existing' ? 'found' : 'installed'}: ${installed.executablePath}`);
  return 0;
}

function createInstallTelemetryContext(parsed: ParsedArgs, target: ParsedArgs['target']): WrapperTelemetryContext {
  return {
    command: parsed.command,
    resolvedCommand: parsed.command === 'install' || parsed.command === 'update' ? parsed.command : undefined,
    target,
    paneVersion: parsed.paneVersion,
    channel: parsed.channel,
    format: parsed.format,
    dryRun: parsed.dryRun,
  };
}

function printDryRun(
  parsed: ParsedArgs,
  artifactName: string,
  preferredDownloadUrl: string,
  fallbackDownloadUrl: string
): void {
  const target = parsed.command === 'update' ? 'client' : parsed.target;
  console.log('runpane dry run');
  console.log(`Command: ${parsed.command}`);
  console.log(`Target: ${target}`);
  console.log(`Pane release: ${parsed.paneVersion}`);
  console.log(`Channel: ${parsed.channel}`);
  console.log(`Format: ${parsed.format}`);
  console.log(`Artifact: ${artifactName}`);
  console.log(`Preferred download: ${preferredDownloadUrl}`);
  console.log(`GitHub fallback: ${fallbackDownloadUrl}`);
  if (parsed.panePath) {
    console.log(`Existing Pane path: ${parsed.panePath}`);
  }
  if (target === 'daemon') {
    console.log(`Pane command: <pane executable> --remote-setup ${parsed.remoteSetupArgs.join(' ')}`.trim());
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
