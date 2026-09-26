import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { boundary, decodeBoundary } from './boundaryDecoder';
import type { ArtifactFormat, InstallTarget, RunpaneCommand } from './commands';
import type { JsonObject, JsonValue } from './boundaryDecoder';
import type { PanePlatform } from './platform';
import { getWrapperVersion } from './version';

const TELEMETRY_ENDPOINT = 'https://runpane.com/api/runpane/telemetry';
const INSTALL_ID_PATTERN = /^install_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TELEMETRY_TIMEOUT_MS = 1500;

export type WrapperTelemetryEventName =
  | 'runpane_wrapper_command_started'
  | 'runpane_wrapper_download_requested'
  | 'runpane_wrapper_download_succeeded'
  | 'runpane_wrapper_download_failed'
  | 'runpane_wrapper_github_fallback_used'
  | 'runpane_wrapper_command_succeeded'
  | 'runpane_wrapper_command_failed';

type WrapperInvocation =
  | 'npm'
  | 'npx'
  | 'npm_global'
  | 'pnpm'
  | 'pnpm_dlx'
  | 'yarn_dlx'
  | 'bunx'
  | 'unknown';

type WrapperFailureStage =
  | 'parse'
  | 'resolve_release'
  | 'download'
  | 'checksum'
  | 'install'
  | 'remote_setup'
  | 'launch'
  | 'unknown';

export type WrapperFailureCategory =
  | 'network'
  | 'timeout'
  | 'not_found'
  | 'permission'
  | 'checksum'
  | 'unsupported_platform'
  | 'validation'
  | 'process_exit'
  | 'unknown';

export interface WrapperTelemetryContext {
  command: RunpaneCommand | 'unknown';
  resolvedCommand?: 'install' | 'update' | 'doctor' | 'help' | 'unknown';
  target?: InstallTarget;
  paneVersion?: string;
  channel?: 'stable' | 'nightly';
  format?: ArtifactFormat;
  platform?: PanePlatform;
  resolvedFormat?: Exclude<ArtifactFormat, 'auto'>;
  dryRun?: boolean;
  installKind?: 'existing' | 'installed' | 'launched-installer';
  usedFallback?: boolean;
  failureStage?: WrapperFailureStage;
  failureCategory?: WrapperFailureCategory;
  exitCode?: number;
}

interface WrapperTelemetryProperties {
  [key: string]: string | number | boolean;
}

interface WrapperTelemetryInput {
  installId: string;
  wrapperVersion: string;
  invocation: WrapperInvocation;
  context: WrapperTelemetryContext;
}

export function createInitialTelemetryContext(argv: string[]): WrapperTelemetryContext {
  const first = argv[0];
  if (!first) {
    return { command: 'setup', resolvedCommand: 'help' };
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    return { command: 'help', resolvedCommand: 'help' };
  }
  if (first === '-v' || first === '--version') {
    return { command: 'version' };
  }
  if (first === 'install') {
    const target = argv[1] === 'daemon' || argv[1] === 'client' ? argv[1] : 'client';
    return { command: 'install', resolvedCommand: 'install', target };
  }
  if (first === 'setup') {
    return { command: 'setup' };
  }
  if (first === 'update') {
    return { command: 'update', resolvedCommand: 'update', target: 'client' };
  }
  if (first === 'doctor') {
    return { command: 'doctor', resolvedCommand: 'doctor' };
  }
  if (first === 'version') {
    return { command: 'version' };
  }
  if (first === 'agent-context') {
    return { command: 'agent-context' };
  }
  if (first === 'agents') {
    return { command: argv[1] === 'doctor' ? 'agents doctor' : 'unknown' };
  }
  if (first === 'repos') {
    return { command: argv[1] === 'add' ? 'repos add' : 'repos list' };
  }
  if (first === 'panes') {
    if (argv[1] === 'list') return { command: 'panes list' };
    if (argv[1] === 'cost') return { command: 'panes cost' };
    if (argv[1] === 'adopt') return { command: 'panes adopt' };
    if (argv[1] === 'handoff') return { command: 'panes handoff' };
    if (argv[1] === 'receive') return { command: 'panes receive' };
    return { command: 'panes create' };
  }
  if (first === 'panels') {
    if (argv[1] === 'output') return { command: 'panels output' };
    if (argv[1] === 'input') return { command: 'panels input' };
    if (argv[1] === 'screen') return { command: 'panels screen' };
    if (argv[1] === 'submit') return { command: 'panels submit' };
    if (argv[1] === 'wait') return { command: 'panels wait' };
    return { command: 'panels list' };
  }
  return { command: 'unknown' };
}

export function applyParsedArgsToTelemetryContext(
  context: WrapperTelemetryContext,
  parsed: {
    command: RunpaneCommand;
    target: InstallTarget;
    paneVersion: string;
    channel: 'stable' | 'nightly';
    format: ArtifactFormat;
    dryRun: boolean;
  }
): void {
  context.command = parsed.command;
  context.target = parsed.command === 'update' ? 'client' : parsed.target;
  context.paneVersion = parsed.paneVersion;
  context.channel = parsed.channel;
  context.format = parsed.format;
  context.dryRun = parsed.dryRun;
  if (parsed.command === 'install' || parsed.command === 'update') {
    context.resolvedCommand = parsed.command;
  }
  if (parsed.command === 'help') {
    context.resolvedCommand = 'help';
  }
  if (parsed.command === 'doctor') {
    context.resolvedCommand = 'doctor';
  }
}

export function setSetupSelection(
  context: WrapperTelemetryContext,
  resolvedCommand: 'install' | 'update' | 'doctor',
  target?: InstallTarget
): void {
  context.command = 'setup';
  context.resolvedCommand = resolvedCommand;
  context.target = target;
}

export function categorizeFailure(cause: unknown): WrapperFailureCategory {
  const message = cause instanceof Error ? cause.message : String(cause);
  const normalized = message.toLowerCase();
  if (normalized.includes('checksum')) return 'checksum';
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'timeout';
  if (normalized.includes('enoent') || normalized.includes('not found') || normalized.includes('404')) return 'not_found';
  if (normalized.includes('permission') || normalized.includes('eacces') || normalized.includes('eperm')) return 'permission';
  if (normalized.includes('unsupported')) return 'unsupported_platform';
  if (normalized.includes('invalid') || normalized.includes('required') || normalized.includes('validation')) return 'validation';
  if (
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('socket') ||
    normalized.includes('econn') ||
    normalized.includes('enotfound')
  ) {
    return 'network';
  }
  return 'unknown';
}

function detectNpmInvocation(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): WrapperInvocation {
  const userAgent = (env.npm_config_user_agent ?? '').toLowerCase();
  const npmCommand = (env.npm_command ?? '').toLowerCase();
  const execPath = (env.npm_execpath ?? '').toLowerCase();
  const argvText = argv.join(' ').toLowerCase();

  if (userAgent.includes('bun') || execPath.includes('bun') || argvText.includes('bunx')) {
    return 'bunx';
  }
  if (userAgent.includes('yarn') || execPath.includes('yarn')) {
    return 'yarn_dlx';
  }
  if (userAgent.includes('pnpm') || execPath.includes('pnpm')) {
    return npmCommand === 'dlx' || argvText.includes(' dlx ') ? 'pnpm_dlx' : 'pnpm';
  }
  if (npmCommand === 'exec' || argvText.includes('npx')) {
    return 'npx';
  }
  if (env.npm_config_global === 'true') {
    return 'npm_global';
  }
  if (userAgent.includes('npm') || execPath.includes('npm')) {
    return 'npm';
  }
  return 'unknown';
}

export function buildWrapperTelemetryProperties(input: WrapperTelemetryInput): WrapperTelemetryProperties {
  const { context } = input;
  const properties: WrapperTelemetryProperties = {
    install_id: input.installId,
    wrapper: 'npm',
    invocation: input.invocation,
    command: context.command,
    download_source: 'npm',
  };

  setIfDefined(properties, 'wrapper_version', sanitizeShortString(input.wrapperVersion));
  setIfDefined(properties, 'resolved_command', context.resolvedCommand);
  setIfDefined(properties, 'target', context.target);
  setIfDefined(properties, 'platform', context.platform?.os);
  setIfDefined(properties, 'arch', context.platform?.arch);
  setIfDefined(properties, 'pane_version', sanitizeShortString(context.paneVersion));
  setIfDefined(properties, 'channel', context.channel);
  setIfDefined(properties, 'format', context.resolvedFormat ?? context.format);
  setIfDefined(properties, 'dry_run', context.dryRun);
  setIfDefined(properties, 'install_kind', context.installKind);
  setIfDefined(properties, 'used_fallback', context.usedFallback);
  setIfDefined(properties, 'failure_stage', context.failureStage);
  setIfDefined(properties, 'failure_category', context.failureCategory);
  setIfDefined(properties, 'exit_code', sanitizeExitCode(context.exitCode));

  return properties;
}

export async function trackWrapperEvent(
  event: WrapperTelemetryEventName,
  context: WrapperTelemetryContext
): Promise<void> {
  if (isTelemetryDisabled()) {
    return;
  }

  try {
    const installId = await getOrCreateWrapperInstallId();
    const properties = buildWrapperTelemetryProperties({
      installId,
      wrapperVersion: getWrapperVersion(),
      invocation: detectNpmInvocation(),
      context,
    });
    await postTelemetry({ event, properties });
  } catch {
    // Telemetry must not affect wrapper behavior.
  }
}

function appDirectory(): string {
  return process.env.PANE_DIR || process.env.FOOZOL_DIR || path.join(os.homedir(), '.pane');
}

async function getOrCreateWrapperInstallId(): Promise<string> {
  const dir = appDirectory();
  const configPath = path.join(dir, 'config.json');
  const fallbackPath = path.join(dir, 'runpane-wrapper-identity.json');
  await fs.mkdir(dir, { recursive: true });

  const config = await readConfig(configPath);
  if (config.status === 'ok') {
    const analytics = readJsonObject(config.value.analytics);
    const existing = readInstallId(analytics.installId);
    if (existing !== undefined) {
      return existing;
    }

    const installId = createInstallId();
    const nextConfig: JsonObject = {
      ...config.value,
      analytics: {
        ...analytics,
        installId,
      },
    };
    await fs.writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    return installId;
  }

  if (config.status === 'missing') {
    const installId = createInstallId();
    await fs.writeFile(configPath, `${JSON.stringify({ analytics: { installId } }, null, 2)}\n`, 'utf8');
    return installId;
  }

  return getOrCreateFallbackInstallId(fallbackPath);
}

async function readConfig(configPath: string): Promise<
  | { status: 'ok'; value: JsonObject }
  | { status: 'missing' }
  | { status: 'invalid' }
> {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return { status: 'ok', value: decodeBoundary(JSON.parse(raw), boundary.jsonObject) };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'invalid' };
  }
}

async function getOrCreateFallbackInstallId(fallbackPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(fallbackPath, 'utf8');
    const parsed = decodeBoundary(JSON.parse(raw), boundary.jsonObject);
    const existing = readInstallId(parsed.installId);
    if (existing !== undefined) {
      return existing;
    }
  } catch {
    // Fall through and create a new fallback identity.
  }

  const installId = createInstallId();
  await fs.writeFile(fallbackPath, `${JSON.stringify({ installId }, null, 2)}\n`, 'utf8');
  return installId;
}

async function postTelemetry(payload: { event: WrapperTelemetryEventName; properties: WrapperTelemetryProperties }): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'runpane-installer' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isTelemetryDisabled(): boolean {
  return Boolean(process.env.CI || process.env.RUNPANE_TELEMETRY_DISABLED);
}

function createInstallId(): string {
  return `install_${randomUUID()}`;
}

function sanitizeShortString(value: string | undefined): string | undefined {
  if (!value || value.length > 80 || /[\\/]/.test(value)) {
    return undefined;
  }
  return value;
}

function sanitizeExitCode(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 0 || value > 255) {
    return undefined;
  }
  return value;
}

function setIfDefined(
  properties: WrapperTelemetryProperties,
  key: string,
  value: string | number | boolean | undefined
): void {
  if (value !== undefined) {
    properties[key] = value;
  }
}

function readJsonObject(value: JsonValue | undefined): JsonObject {
  try {
    return decodeBoundary(value, boundary.jsonObject);
  } catch {
    return {};
  }
}

function readInstallId(value: JsonValue | undefined): string | undefined {
  try {
    const installId = decodeBoundary(value, boundary.string);
    return INSTALL_ID_PATTERN.test(installId) ? installId : undefined;
  } catch {
    return undefined;
  }
}

function isNodeError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && 'code' in cause;
}
