import { boundary, decodeBoundary, type JsonObject, type JsonValue } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon } from './daemonClient';

/**
 * Session ports from the CLI: `runpane port open|list|close|auto-open` inside a cloud Session (the
 * local daemon, or `--host`), and `runpane cloud port open|list|close <host>` from the laptop. Both
 * call the daemon's `runpane:ports:*` channels; this module parses, calls and prints.
 */

export const PORT_USAGE = `Usage:
  runpane port open <port> [--name <name>] [--https-port <port>] [--path </path>] [--scheme <auto|https|http>] [--yes] [--json]
  runpane port list [--verify] [--json]
  runpane port close <port|name> [--json]
  runpane port auto-open <on|off> [--json]
Inside a Runpane Cloud Session: publish a local service as a tailnet-only URL, https://<host>.<tailnet>.ts.net:<port>/
(Tailscale Serve, never Funnel). From your laptop: runpane cloud port open|list|close <host> ...`;

export const CLOUD_PORT_USAGE = `Usage:
  runpane cloud port open <host> <port> [--name <name>] [--https-port <port>] [--path </path>] [--scheme <auto|https|http>] [--yes] [--json]
  runpane cloud port list <host> [--json]
  runpane cloud port close <host> <port|name> [--json]
Publishes a service running in the Session as a tailnet-only URL on the Session's own name,
https://<host>.<tailnet>.ts.net:<port>/ (Tailscale Serve, never Funnel). list checks each URL from this machine.
Inside the Session: runpane port open|list|close|auto-open ...`;

type PortsCommand =
  | { sub: 'open'; request: JsonObject; json: boolean }
  | { sub: 'list'; verify: boolean; json: boolean }
  | { sub: 'close'; target: number | string; json: boolean }
  | { sub: 'auto-open'; autoOpen: boolean; json: boolean };

function parsePortNumber(value: string, what: string): number {
  const port = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${what} must be a port number 1-65535, not ${value}.`);
  return port;
}

/**
 * Parses what follows `port` (or `cloud port`). With `withHost`, the first positional is the host.
 * Returns the host (cloud only) and the command.
 */
interface ParsedPortsArgv {
  host?: string;
  command: PortsCommand;
}

export function parsePortsArgv(argv: readonly string[], options: { withHost: boolean; usage: string }): ParsedPortsArgv {
  const [sub, ...rest] = argv;
  if (sub !== 'open' && sub !== 'list' && sub !== 'close' && sub !== 'auto-open') throw new Error(options.usage);
  const positionals: string[] = [];
  const request: JsonObject = {};
  let json = false;
  let verify = false;
  for (let index = 0; index < rest.length; index++) {
    const raw = rest[index] ?? '';
    const separator = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = separator === -1 ? raw : raw.slice(0, separator);
    const value = (): string => {
      const next = separator === -1 ? rest[++index] : raw.slice(separator + 1);
      if (next === undefined || next === '' || (separator === -1 && next.startsWith('--'))) throw new Error(`${flag} requires a value.`);
      return next;
    };
    const openOnly = () => {
      if (sub !== 'open') throw new Error(`${flag} only applies to port open.`);
    };
    if (!flag.startsWith('-')) positionals.push(raw);
    else if (flag === '--json') json = true;
    else if (flag === '--verify' && sub === 'list' && !options.withHost) verify = true;
    else if (flag === '--yes' || flag === '-y') {
      openOnly();
      request.yes = true;
    } else if (flag === '--name') {
      openOnly();
      request.name = value();
    } else if (flag === '--https-port') {
      openOnly();
      request.httpsPort = parsePortNumber(value(), '--https-port');
    } else if (flag === '--path') {
      openOnly();
      request.path = value();
    } else if (flag === '--scheme') {
      openOnly();
      const scheme = value();
      if (scheme !== 'auto' && scheme !== 'https' && scheme !== 'http') throw new Error('--scheme must be auto, https or http.');
      request.scheme = scheme;
    } else throw new Error(`Unknown option for port ${sub}: ${flag}\n\n${options.usage}`);
  }
  const host = options.withHost ? positionals.shift() : undefined;
  if (options.withHost && !host) throw new Error(`runpane cloud port ${sub} needs a host.\n\n${options.usage}`);
  const expected = sub === 'list' ? 0 : 1;
  if (positionals.length !== expected) throw new Error(options.usage);
  const argument = positionals[0] ?? '';
  switch (sub) {
    case 'open':
      return { host, command: { sub, request: { ...request, port: parsePortNumber(argument, 'The port') }, json } };
    case 'list':
      return { host, command: { sub, verify, json } };
    case 'close':
      return { host, command: { sub, target: /^\d+$/u.test(argument) ? parsePortNumber(argument, 'The port') : argument, json } };
    case 'auto-open':
      if (argument !== 'on' && argument !== 'off') throw new Error('runpane port auto-open takes on or off.');
      return { host, command: { sub, autoOpen: argument === 'on', json } };
  }
}

const portSchema = boundary.object({
  name: boundary.string,
  port: boundary.number,
  httpsPort: boundary.number,
  url: boundary.string,
  scheme: boundary.string,
  path: boundary.string,
  source: boundary.string,
  repo: boundary.optional(boundary.string),
  createdAt: boundary.string,
  status: boundary.string,
  detail: boundary.optional(boundary.string),
  reachable: boundary.optional(boundary.nullable(boundary.boolean)),
});

type PortRow = ReturnType<typeof portSchema.decode>;

const listSchema = boundary.object({
  ok: boundary.literal(true),
  available: boundary.boolean,
  unavailableReason: boundary.optional(boundary.string),
  host: boundary.optional(boundary.string),
  scheme: boundary.string,
  autoOpen: boundary.boolean,
  ports: boundary.array(portSchema),
  suggested: boundary.array(boundary.object({
    port: boundary.number,
    address: boundary.string,
    process: boundary.optional(boundary.string),
    pid: boundary.optional(boundary.number),
    paneId: boundary.optional(boundary.string),
    panelId: boundary.optional(boundary.string),
    detectedAt: boundary.string,
  })),
  manifests: boundary.array(boundary.object({
    repo: boundary.string,
    ok: boundary.boolean,
    error: boundary.optional(boundary.string),
    count: boundary.number,
  })),
  stateError: boundary.optional(boundary.string),
});

const openSchema = boundary.object({
  ok: boundary.literal(true),
  port: portSchema,
  alreadyOpen: boundary.boolean,
  replaced: boundary.optional(boundary.object({ httpsPort: boundary.number, was: boundary.string })),
});

const closeSchema = boundary.object({ ok: boundary.literal(true), closed: boundary.nullable(portSchema) });
const configureSchema = boundary.object({ ok: boundary.literal(true), autoOpen: boundary.boolean });

interface PortsIo {
  /** Calls a `runpane:ports:*` channel on the Session's daemon. */
  invoke(channel: string, args: JsonObject[]): Promise<JsonValue | undefined>;
  stdout(line: string): void;
  /** From the laptop: request each URL over the tailnet; any answer but 502 counts. */
  checkUrl?(url: string): Promise<{ reachable: boolean; detail?: string }>;
}

/** Runs one ports command and prints its result; returns the exit code. */
export async function runPortsCommand(command: PortsCommand, io: PortsIo): Promise<number> {
  switch (command.sub) {
    case 'open': {
      const result = decodeBoundary(await io.invoke('runpane:ports:open', [command.request]), openSchema);
      if (command.json) {
        io.stdout(JSON.stringify(result, null, 2));
        return 0;
      }
      if (result.replaced) io.stdout(`Replaced the Tailscale Serve entry on :${result.replaced.httpsPort} (${result.replaced.was}).`);
      io.stdout(`${result.alreadyOpen ? 'Already published' : 'Published'} ${result.port.name}: ${result.port.url}`);
      if (result.port.detail) io.stdout(`  ${result.port.detail}`);
      return 0;
    }
    case 'list': {
      const result = decodeBoundary(await io.invoke('runpane:ports:list', [{ verify: command.verify }]), listSchema);
      const checkUrl = io.checkUrl;
      const ports: PortRow[] = checkUrl
        ? await Promise.all(result.ports.map(async (port) => port.status === 'serving' ? { ...port, ...(await checkUrl(port.url)) } : { ...port, reachable: false }))
        : result.ports;
      if (command.json) {
        io.stdout(JSON.stringify({ ...result, ports }, null, 2));
        return 0;
      }
      printList({ ...result, ports }, io.stdout, Boolean(checkUrl) || command.verify);
      return 0;
    }
    case 'close': {
      const result = decodeBoundary(await io.invoke('runpane:ports:close', [{ target: command.target }]), closeSchema);
      if (command.json) io.stdout(JSON.stringify(result, null, 2));
      else io.stdout(result.closed ? `Closed ${result.closed.name} (${result.closed.url}).` : `No published port ${command.target}.`);
      return result.closed ? 0 : 1;
    }
    case 'auto-open': {
      const result = decodeBoundary(await io.invoke('runpane:ports:configure', [{ autoOpen: command.autoOpen }]), configureSchema);
      if (command.json) io.stdout(JSON.stringify(result, null, 2));
      else io.stdout(result.autoOpen
        ? 'Auto-open is on: ports agents start listening on are published on the tailnet without asking.'
        : 'Auto-open is off: new listening ports are only suggested (runpane port list).');
      return 0;
    }
  }
}

function printList(result: ReturnType<typeof listSchema.decode>, out: (line: string) => void, checked: boolean): void {
  if (!result.available) {
    out(`Session ports are not available here: ${result.unavailableReason ?? 'unknown reason'}.`);
    out('From your laptop, use: runpane cloud port list <host>');
    return;
  }
  out(`Ports on ${result.host ?? 'this Session'} (tailnet only):`);
  if (result.stateError) out(`  State file problem: ${result.stateError}`);
  if (result.ports.length === 0) out('  none published (runpane port open <port>)');
  const rows = result.ports.map((port) => [
    port.name,
    String(port.port),
    port.url,
    port.source,
    port.status,
    ...(checked ? [port.reachable === true ? 'yes' : port.reachable === false ? 'NO' : '-'] : []),
  ]);
  if (rows.length > 0) {
    const header = ['NAME', 'PORT', 'URL', 'SOURCE', 'STATUS', ...(checked ? ['REACHABLE'] : [])];
    const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)));
    for (const row of [header, ...rows]) out(`  ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd()}`);
    for (const port of result.ports) if (port.detail) out(`  ${port.name}: ${port.detail}`);
  }
  if (result.suggested.length > 0) {
    out('Suggested (listening under a Pane panel, not published):');
    for (const suggestion of result.suggested) {
      out(`  ${suggestion.port} on ${suggestion.address}${suggestion.process ? ` (${suggestion.process})` : ''}: runpane port open ${suggestion.port}`);
    }
  }
  for (const manifest of result.manifests) {
    out(`Manifest ${manifest.repo}/.runpane/ports.json: ${manifest.ok ? `${manifest.count} port(s)` : 'INVALID'}${manifest.error ? ` (${manifest.error})` : ''}`);
  }
  out(`Auto-open: ${result.autoOpen ? 'on' : 'off'}`);
}

/** The laptop's check of one URL: a GET over the tailnet within 5 s. */
export async function checkUrlFromHere(url: string): Promise<{ reachable: boolean; detail?: string }> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    if (response.status === 502) return { reachable: false, detail: 'Tailscale Serve answered 502: nothing listens on the local port in the Session' };
    return { reachable: true };
  } catch (error) {
    const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    return { reachable: false, detail: `no answer from this machine: ${reason}` };
  }
}

/** `runpane port ...`: the local daemon (in a Session), or the `--host` target. */
export async function runPort(parsed: ParsedArgs): Promise<number> {
  const { command } = parsePortsArgv(parsed.portArgv ?? [], { withHost: false, usage: PORT_USAGE });
  return runPortsCommand(command, {
    invoke: (channel, args) => invokeDaemon(channel, args, boundary.json, { paneDir: parsed.paneDir, timeoutMs: 90_000 }),
    stdout: (line) => console.log(line),
  });
}
