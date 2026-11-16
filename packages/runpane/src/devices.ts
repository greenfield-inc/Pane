import { boundary, decodeBoundary, type JsonValue } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { confirmMutation } from './daemonActions';
import { invokeDaemon } from './daemonClient';
import { RunpaneError } from './errors';

// `runpane devices`: phone simulators and emulators for the calling tab's Pane (docs/DEVICES.md).
// Pane fills in the Pane, device and machine from the caller; nothing here names them.

const summarySchema = boundary.object({
  name: boundary.string,
  platform: boundary.string,
  os: boundary.string,
  machine: boundary.string,
  state: boundary.string,
  heldBy: boundary.optional(boundary.object({ paneId: boundary.string, paneName: boundary.string })),
});
const listSchema = boundary.object({ ok: boundary.literal(true), devices: boundary.array(summarySchema) });
const openSchema = boundary.object({ ok: boundary.literal(true), device: summarySchema });
const screenshotSchema = boundary.object({ ok: boundary.literal(true), path: boundary.string });
const actSchema = boundary.object({ ok: boundary.literal(true), exitCode: boundary.number, output: boundary.string });
const runSchema = boundary.object({ ok: boundary.literal(true), jobId: boundary.optional(boundary.string), state: boundary.optional(boundary.string), exitCode: boundary.optional(boundary.number), logTail: boundary.optional(boundary.string) });
const freeSchema = boundary.object({ ok: boundary.literal(true), shutdown: boundary.array(boundary.string), deleted: boundary.array(boundary.string), checkouts: boundary.array(boundary.string), freedBytes: boundary.number });

/** What `runpane:devices:run` takes. */
interface DeviceRunRequest { command?: string; background?: boolean; waitMs?: number; platform?: 'ios' | 'android' }

/** Which of the Pane's devices a call acts on; Pane picks the one opened last when `platform` is absent. */
interface DeviceTarget { platform?: 'ios' | 'android' }

/** `--platform` for screenshot, act, run and close. */
function targetPlatform(parsed: ParsedArgs, command: string): DeviceTarget {
  const platform = parsed.devicePlatform;
  if (platform === undefined) return {};
  if (platform !== 'ios' && platform !== 'android') {
    throw new RunpaneError('ERR_DEVICE_INVALID_REQUEST', `runpane devices ${command} takes --platform ios or --platform android, not "${platform}". Nothing ran.`, `Run \`runpane devices ${command} --platform ios\`, or leave --platform out for the device opened last.`);
  }
  return { platform };
}

/** Prints the daemon's result as JSON with --json, otherwise as `text`. */
function print(parsed: ParsedArgs, result: JsonValue, text: string): number {
  console.log(parsed.json ? JSON.stringify(result, null, 2) : text);
  return 0;
}

/**
 * Splits one command line into words: an MCP call passes the text after `--` as one string.
 * Quotes group words; a backslash escapes the next character outside single quotes.
 */
function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | '\'' | undefined;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"' && index + 1 < line.length) current += line[++index];
      else current += char;
    } else if (char === '"' || char === '\'') {
      quote = char;
      started = true;
    } else if (char === '\\' && index + 1 < line.length) {
      current += line[++index];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new RunpaneError('ERR_DEVICE_INVALID_REQUEST', `The command has an unclosed ${quote} quote. Nothing ran.`, 'Close the quote and try again.');
  if (started) words.push(current);
  return words;
}

/** The words after `--`: as given by a shell, or split from the one string an MCP call sends. */
function commandWords(parsed: ParsedArgs): string[] {
  const words = parsed.execCommand ?? [];
  return words.length === 1 ? splitCommandLine(words[0]) : words;
}

export async function runDevicesList(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon('runpane:devices:list', [{}], boundary.json, { paneDir: parsed.paneDir });
  const { devices } = decodeBoundary(result, listSchema);
  return print(parsed, result, devices.length === 0
    ? 'No simulators or emulators here. Install Xcode or Android Studio, or link a Mac for iOS.'
    : devices.map(device => `${device.platform}\t${device.name}\t${device.os}\t${device.machine}\t${device.state}${device.heldBy ? `\theld by ${device.heldBy.paneName}` : ''}`).join('\n'));
}

/** First use installs the helpers, may create a device, and cold-boots it (over 2 minutes on Windows). */
const OPEN_TIMEOUT_MS = 10 * 60_000;
/** agent-device installs apps and waits on screens. */
const ACT_TIMEOUT_MS = 5 * 60_000;
/** Pane waits this long for a run's command by default, and syncing to a linked Mac comes on top. */
const RUN_WAIT_MS = 120_000;
const SYNC_ALLOWANCE_MS = 5 * 60_000;

export async function runDevicesOpen(parsed: ParsedArgs): Promise<number> {
  const platform = parsed.devicePlatform;
  if (platform !== 'ios' && platform !== 'android') {
    throw new RunpaneError('ERR_DEVICE_INVALID_REQUEST', 'runpane devices open needs --platform ios or --platform android. Nothing was opened.', 'Run `runpane devices open --platform ios`.');
  }
  const request = parsed.deviceName ? { platform, device: parsed.deviceName } : { platform };
  const result = await invokeDaemon('runpane:devices:open', [request], boundary.json, { paneDir: parsed.paneDir, timeoutMs: OPEN_TIMEOUT_MS });
  const { device } = decodeBoundary(result, openSchema);
  return print(parsed, result, `Opened ${device.name} · ${device.os} on ${device.machine}.`);
}

export async function runDevicesScreenshot(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon('runpane:devices:screenshot', [targetPlatform(parsed, 'screenshot')], boundary.json, { paneDir: parsed.paneDir });
  return print(parsed, result, decodeBoundary(result, screenshotSchema).path);
}

export async function runDevicesAct(parsed: ParsedArgs): Promise<number> {
  const args = commandWords(parsed);
  if (args.length === 0) {
    throw new RunpaneError('ERR_DEVICE_ACT_EMPTY', 'runpane devices act needs an agent-device command after --. Nothing ran.', 'Run `runpane devices act -- snapshot -i`.');
  }
  const result = await invokeDaemon('runpane:devices:act', [{ args, ...targetPlatform(parsed, 'act') }], boundary.json, { paneDir: parsed.paneDir, timeoutMs: ACT_TIMEOUT_MS });
  const { exitCode, output } = decodeBoundary(result, actSchema);
  print(parsed, result, output);
  return parsed.json ? 0 : exitCode;
}

export async function runDevicesRun(parsed: ParsedArgs): Promise<number> {
  const words = parsed.execCommand ?? [];
  const command = words.length === 1 ? words[0] : words.join(' ');
  const request: DeviceRunRequest = { ...targetPlatform(parsed, 'run') };
  if (command.trim()) request.command = command;
  if (parsed.deviceBackground) request.background = true;
  if (parsed.deviceWaitMs !== undefined) request.waitMs = parsed.deviceWaitMs;
  const result = await invokeDaemon('runpane:devices:run', [request], boundary.json, { paneDir: parsed.paneDir, timeoutMs: (request.waitMs ?? RUN_WAIT_MS) + SYNC_ALLOWANCE_MS });
  const run = decodeBoundary(result, runSchema);
  const still = run.state === 'running' ? `\nStill running as job ${run.jobId ?? ''}.` : '';
  print(parsed, result, `${run.logTail ?? ''}${still}`);
  return parsed.json ? 0 : run.exitCode ?? 0;
}

export async function runDevicesClose(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon('runpane:devices:close', [targetPlatform(parsed, 'close')], boundary.json, { paneDir: parsed.paneDir });
  return print(parsed, result, 'Closed. The device stays warm for 10 minutes.');
}

export async function runDevicesUsage(parsed: ParsedArgs): Promise<number> {
  const result = await invokeDaemon('runpane:devices:usage', [{}], boundary.json, { paneDir: parsed.paneDir });
  return print(parsed, result, JSON.stringify(result, null, 2));
}

export async function runDevicesFree(parsed: ParsedArgs): Promise<number> {
  if (parsed.deviceIdle === parsed.all) {
    throw new RunpaneError('ERR_DEVICE_INVALID_REQUEST', 'runpane devices free needs exactly one of --idle or --all. Nothing was changed.', 'Run `runpane devices free --idle --yes`.');
  }
  await confirmMutation(parsed);
  // Each device waits for its shutdown before it is deleted.
  const result = await invokeDaemon('runpane:devices:free', [{ mode: parsed.all ? 'all' : 'idle' }], boundary.json, { paneDir: parsed.paneDir, timeoutMs: OPEN_TIMEOUT_MS });
  const freed = decodeBoundary(result, freeSchema);
  return print(parsed, result, `Shut down ${freed.shutdown.length}, deleted ${freed.deleted.length} devices and ${freed.checkouts.length} checkouts, freed ${Math.round(freed.freedBytes / 1_000_000)} MB.`);
}
