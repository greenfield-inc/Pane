#!/usr/bin/env node
import { RUNPANE_CONTRACT } from './generated/contract';
import * as os from 'node:os';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import * as prompts from './setupPrompts';
import { runAgentContext } from './agentContext';
import { runAgentsSend, runAgentsStart, runAgentsStatus } from './agentTasks';
import { daemonActionFor, runDaemonAction } from './daemonActions';
import { runDocsRead, runDocsSearch } from './docs';
import { runLinksCreate } from './links';
import { helpText, parseRunpaneArgs, type ParsedArgs, type RunpaneCommand } from './commands';
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
  runPanelsLastMessage,
  runPanelsList,
  runPanelsOutput,
  runPanelsScreen,
  runPanelsSubmit,
  runPanelsSubmitComposer,
  runPanelsWait,
  runPanesArchive,
  runPanesAdopt,
  runPanesCreate,
  runPanesCost,
  runPanesList,
  runPanesPin,
  runPanesRename,
  runPanesFocus,
  runReport,
  runPanelsOpen,
  runSessionsAssociate,
  runSessionsCreate,
  runSessionsDetach,
  runSessionsGet,
  runSessionsList,
  runSessionsOverview,
  runLockAcquire,
  runLockList,
  runLockRelease,
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

/** Loaded lazily so the rest of the CLI never pays for the cloud modules. */
async function runCloudCommand(parsed: ParsedArgs): Promise<number> {
  if (!parsed.cloudArgv) throw new Error('Missing cloud arguments');
  const { runCloud } = await import('./cloud/cli');
  return runCloud(parsed.cloudArgv);
}

type CommandHandler = (parsed: ParsedArgs, telemetryContext: WrapperTelemetryContext) => number | Promise<number>;

const commandHandlers = new Map<string, CommandHandler>(Object.entries({
  'help': async (parsed, telemetryContext) => {
    console.log(helpText(parsed.helpTopic));
    return 0;
  },
  'setup': async (parsed, telemetryContext) => {
    return runNoArgsEntrypoint(telemetryContext);
  },
  'version': async (parsed, telemetryContext) => {
    return printVersion(parsed.panePath);
  },
  'doctor': async (parsed, telemetryContext) => {
    return runDoctor(parsed, SOURCE);
  },
  'daemon repair': async (parsed, telemetryContext) => {
    return runDaemonRepair(parsed);
  },
  'agent-context': async (parsed, telemetryContext) => {
    return runAgentContext(parsed);
  },
  'mcp': async (parsed, telemetryContext) => {
    const { runMcpServer } = await import('./mcp');
    return runMcpServer({ toolsets: parsed.toolsets, readOnly: parsed.readOnly === true });
  },
  'links create': async (parsed, telemetryContext) => {
    return runLinksCreate(parsed);
  },
  'docs search': async (parsed, telemetryContext) => {
    return runDocsSearch(parsed);
  },
  'docs read': async (parsed, telemetryContext) => {
    return runDocsRead(parsed);
  },
  'agents start': async (parsed, telemetryContext) => {
    return runAgentsStart(parsed);
  },
  'agents status': async (parsed, telemetryContext) => {
    return runAgentsStatus(parsed);
  },
  'agents send': async (parsed, telemetryContext) => {
    return runAgentsSend(parsed);
  },
  'repos list': async (parsed, telemetryContext) => {
    return runReposList(parsed);
  },
  'repos add': async (parsed, telemetryContext) => {
    return runReposAdd(parsed);
  },
  'panes list': async (parsed, telemetryContext) => {
    return runPanesList(parsed);
  },
  'panes cost': async (parsed, telemetryContext) => {
    return runPanesCost(parsed);
  },
  'sessions list': async (parsed, telemetryContext) => {
    return runSessionsList(parsed);
  },
  'sessions create': async (parsed, telemetryContext) => {
    return runSessionsCreate(parsed);
  },
  'sessions get': async (parsed, telemetryContext) => {
    return runSessionsGet(parsed);
  },
  'sessions update': async (parsed, telemetryContext) => {
    return runSessionsUpdate(parsed);
  },
  'sessions set-agent': async (parsed, telemetryContext) => {
    return runSessionsSetAgent(parsed);
  },
  'sessions associate': async (parsed, telemetryContext) => {
    return runSessionsAssociate(parsed);
  },
  'sessions detach': async (parsed, telemetryContext) => {
    return runSessionsDetach(parsed);
  },
  'sessions overview': async (parsed, telemetryContext) => {
    return runSessionsOverview(parsed);
  },
  'lock acquire': async (parsed, telemetryContext) => {
    return runLockAcquire(parsed);
  },
  'lock release': async (parsed, telemetryContext) => {
    return runLockRelease(parsed);
  },
  'lock list': async (parsed, telemetryContext) => {
    return runLockList(parsed);
  },
  'workspace state': async (parsed, telemetryContext) => {
    return runWorkspaceState(parsed);
  },
  'watch': async (parsed, telemetryContext) => {
    return runWatch(parsed);
  },
  'panes create': async (parsed, telemetryContext) => {
    return runPanesCreate(parsed);
  },
  'panes adopt': async (parsed, telemetryContext) => {
    return runPanesAdopt(parsed);
  },
  'panes archive': async (parsed, telemetryContext) => {
    return runPanesArchive(parsed);
  },
  'panes pin': async (parsed, telemetryContext) => {
    return runPanesPin(parsed, true);
  },
  'panes unpin': async (parsed, telemetryContext) => {
    return runPanesPin(parsed, false);
  },
  'panes rename': async (parsed, telemetryContext) => {
    return runPanesRename(parsed);
  },
  'panes focus': async (parsed, telemetryContext) => {
    return runPanesFocus(parsed);
  },
  'panels list': async (parsed, telemetryContext) => {
    return runPanelsList(parsed);
  },
  'panels create': async (parsed, telemetryContext) => {
    return runPanelsCreate(parsed);
  },
  'panels open': async (parsed, telemetryContext) => {
    return runPanelsOpen(parsed);
  },
  'panels output': async (parsed, telemetryContext) => {
    return runPanelsOutput(parsed);
  },
  'panels input': async (parsed, telemetryContext) => {
    return runPanelsInput(parsed);
  },
  'panels screen': async (parsed, telemetryContext) => {
    return runPanelsScreen(parsed);
  },
  'panels submit': async (parsed, telemetryContext) => {
    return runPanelsSubmit(parsed);
  },
  'panels submit-composer': async (parsed, telemetryContext) => {
    return runPanelsSubmitComposer(parsed);
  },
  'panels wait': async (parsed, telemetryContext) => {
    return runPanelsWait(parsed);
  },
  'panels last-message': async (parsed, telemetryContext) => {
    return runPanelsLastMessage(parsed);
  },
  'report': async (parsed, telemetryContext) => {
    return runReport(parsed);
  },
  'agents doctor': async (parsed, telemetryContext) => {
    return runAgentsDoctor(parsed);
  },
  'install': async (parsed, telemetryContext) => {
    return installOrUpdate(parsed, telemetryContext);
  },
  'update': async (parsed, telemetryContext) => {
    return installOrUpdate(parsed, telemetryContext);
  },
  'panes git-status': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes commit': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes push': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes pull': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes rebase-main': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes restore': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes squash-rebase': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes stash': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes stash-pop': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes soft-reset': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes fetch': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes run-script': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes stop-script': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'panes move': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'folders list': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'folders create': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'links open': (parsed) => { const action = daemonActionFor(parsed.command); if (!action) throw new Error('Missing daemon action'); return runDaemonAction(parsed, action); },
  'cloud setup': (parsed) => runCloudCommand(parsed),
  'cloud new': (parsed) => runCloudCommand(parsed),
  'cloud list': (parsed) => runCloudCommand(parsed),
  'cloud status': (parsed) => runCloudCommand(parsed),
  'cloud stop': (parsed) => runCloudCommand(parsed),
  'cloud start': (parsed) => runCloudCommand(parsed),
  'cloud update': (parsed) => runCloudCommand(parsed),
  'cloud remove': (parsed) => runCloudCommand(parsed),
} satisfies Record<RunpaneCommand, CommandHandler>));

const contractCommands = new Set<string>(RUNPANE_CONTRACT.commands.map(command => command.name));
const missingHandlers = [...contractCommands].filter(command => !commandHandlers.has(command));
const unexpectedHandlers = [...commandHandlers.keys()].filter(command => !contractCommands.has(command));
if (missingHandlers.length) throw new Error('Missing command handlers: '+missingHandlers.join(', '));
if (unexpectedHandlers.length) throw new Error('Unexpected command handlers: '+unexpectedHandlers.join(', '));

async function dispatchParsedCommand(parsed: ParsedArgs, telemetryContext: WrapperTelemetryContext): Promise<number> {
  const handler = commandHandlers.get(parsed.command);
  if (!handler) throw new Error('Unsupported command: '+parsed.command);
  return handler(parsed, telemetryContext);
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
  prompts.intro('Pane setup');
  const action = await prompts.select({
    message: 'What should this machine do?',
    options: [
      { value: 'client', label: 'Install Pane desktop', hint: 'work on this machine' },
      { value: 'daemon', label: 'Set up a remote host', hint: 'run agents here, connect from another device' },
      { value: 'update', label: 'Update Pane', hint: 'install the latest desktop release' },
      { value: 'doctor', label: 'Check this machine', hint: 'diagnose an existing setup' }
    ]
  });
  if (prompts.isCancel(action)) {
    prompts.cancel('Setup cancelled.');
    return 0;
  }

  if (action === 'doctor') {
    prompts.outro('Checking your Pane installation…');
    setSetupSelection(telemetryContext, 'doctor');
    return runDoctor(createParsedArgs('doctor'), SOURCE);
  }

  let parsed: ParsedArgs;
  if (action === 'daemon') {
    const defaultLabel = os.hostname() || 'Remote Host';
    const label = await prompts.text({
      message: 'Name this host',
      placeholder: defaultLabel,
      defaultValue: defaultLabel,
      validate: value => value && !value.trim() ? 'Enter a name, or leave blank to use this computer’s name.' : undefined
    });
    if (prompts.isCancel(label)) {
      prompts.cancel('Setup cancelled.');
      return 0;
    }
    prompts.log.info('Pane will install Tailscale if needed and guide you through signing in.');
    prompts.log.info('For SSH or a manual URL: runpane install daemon --help');
    parsed = createParsedArgs('install', {
      target: 'daemon',
      remoteSetupArgs: [
        '--label', label.trim() || defaultLabel,
        '--prefer-tunnel', 'tailscale',
        '--interactive-tailscale-setup',
        '--auto-listen-port'
      ]
    });
    prompts.outro('Setting up your remote host. Follow the login prompts below.');
  } else {
    parsed = createParsedArgs(action === 'update' ? 'update' : 'install', { target: 'client' });
    prompts.outro(action === 'update' ? 'Updating Pane…' : 'Installing Pane…');
  }

  // All prompts have finished before the child inherits stdin for login/sudo.
  setSetupSelection(telemetryContext, action === 'update' ? 'update' : 'install', parsed.target);
  const code = await installOrUpdate(parsed, telemetryContext);
  if (code === 0) {
    if (parsed.target === 'daemon') {
      prompts.log.success('Remote host setup finished.');
      prompts.log.info('Sign your other device into the same Tailscale network, then paste the connection code above into Pane or https://runpane.com/app/.');
    } else {
      prompts.log.success('Pane is ready.');
    }
  } else {
    prompts.log.error('Setup did not finish. Review the error above, then rerun runpane setup.');
  }
  return code;
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
