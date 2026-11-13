import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { tokenizeShellCommand } from './agents/agentIdentity';
import { PaneMcpEndpoint, setPaneMcpEndpoint, withPaneMcpConfig, type PaneMcpTab } from './paneMcpEndpoint';
import { PANE_MCP_TOKEN_ENV, PANE_MCP_URL_ENV } from './paneMcpNames';
import { TabListener } from './tabListener';

const appDir = mkdtempSync(path.join(os.tmpdir(), 'pane-mcp-endpoint-'));

/**
 * A stand-in runpane CLI: prints, as `--json` output, who ran it, where and with what. With
 * FAKE_HOLD set it writes its pid there and waits, like a `notify` waiting on the person.
 */
const fakeCli = path.join(appDir, 'fake-runpane.js');
writeFileSync(fakeCli, `
if (process.env.FAKE_HOLD) { require('fs').writeFileSync(process.env.FAKE_HOLD, String(process.pid)); setInterval(() => {}, 1000); }
else process.stdout.write(JSON.stringify({
  panel: process.env.PANE_PANEL_ID, cwd: process.cwd(), argv: process.argv.slice(2), paneDir: process.env.PANE_DIR,
  agent: process.env.RUNPANE_NOTIFY_AGENT ?? null, returnAfter: process.env.RUNPANE_NOTIFY_RETURN_AFTER_MS ?? null,
}));
`);

const ranSchema = boundary.object({
  result: boundary.object({
    structuredContent: boundary.object({
      panel: boundary.string, cwd: boundary.string, argv: boundary.array(boundary.string), paneDir: boundary.string,
      agent: boundary.nullable(boundary.string), returnAfter: boundary.nullable(boundary.string),
    }),
  }),
});

let listener: TabListener;
let endpoint: PaneMcpEndpoint | undefined;
let enabled = true;
beforeEach(async () => {
  vi.stubEnv('PANE_DIR', appDir);
  enabled = true;
  listener = new TabListener();
  await listener.start();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  setPaneMcpEndpoint(undefined);
  endpoint?.detachAll();
  endpoint = undefined;
  await listener.stop();
});

function start() {
  endpoint = new PaneMcpEndpoint({
    load: () => import('../../../packages/runpane/src/mcpHttp'),
    cli: () => ({ executable: process.execPath, script: fakeCli }),
    settings: () => ({ enabled }),
    listener,
  });
  endpoint.attach();
  setPaneMcpEndpoint(endpoint);
  return endpoint;
}

function tab(panelId: string, env: Record<string, string> = {}): PaneMcpTab {
  const cwd = mkdtempSync(path.join(os.tmpdir(), `pane-mcp-${panelId}-`));
  return { panelId, cwd, agentLabel: 'Claude', env: { PATH: process.env.PATH ?? '', PANE_PANEL_ID: panelId, ...env } };
}

/** The URL and token a tab's environment carries. */
function grantOf(env: Record<string, string> | undefined) {
  if (!env) throw new Error('expected a grant');
  return { url: env[PANE_MCP_URL_ENV], token: env[PANE_MCP_TOKEN_ENV] };
}

/** The 2026-07-28 shape Claude Code sends: every request carries the revision and the client's name. */
const MODERN_REVISION = '2026-07-28';
const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': MODERN_REVISION,
  'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** One tools/call over streamable HTTP; by default as a 2025-era client sends it, with no name on the request. */
function callRepos(grant: { url: string; token: string }, init: { token?: string; headers?: Record<string, string>; signal?: AbortSignal; modern?: boolean } = {}) {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${init.token ?? grant.token}` });
  const call = { name: 'repos_list', arguments: {} };
  const params = init.modern ? { ...call, _meta: modernMeta } : call;
  if (init.modern) {
    headers.set('mcp-protocol-version', MODERN_REVISION);
    headers.set('mcp-method', 'tools/call');
    headers.set('mcp-name', 'repos_list');
  }
  for (const [name, value] of Object.entries(init.headers ?? {})) headers.set(name, value);
  return fetch(grant.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }), signal: init.signal });
}

/** fetch never sends a Host header of its own choosing, so this one request goes through node:http. */
function statusWithHost(grant: { url: string; token: string }, host: string): Promise<number | undefined> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  return new Promise((resolve, reject) => {
    const request = http.request(grant.url, {
      method: 'POST',
      headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${grant.token}` },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end(body);
  });
}

/** Where and as whom the tool ran, from the call's response (sent as JSON or as one SSE event). */
async function ranAs(response: Response) {
  const text = await response.text();
  const data = text.split('\n').find(line => line.startsWith('data: '));
  return decodeBoundary(JSON.parse(data ? data.slice('data: '.length) : text), ranSchema).result.structuredContent;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('PaneMcpEndpoint', () => {
  it("runs a tool as the tab its token belongs to, in that tab's folder, against this Pane's data folder", async () => {
    const server = start();
    const first = tab('panel-a');
    const second = tab('panel-b');
    const grantA = grantOf(server.grant(first));
    const grantB = grantOf(server.grant(second));

    const ranA = await ranAs(await callRepos(grantA));
    const ranB = await ranAs(await callRepos(grantB));

    expect(ranA).toMatchObject({ panel: 'panel-a', argv: ['repos', 'list', '--json'], paneDir: appDir });
    expect(ranA.cwd).toBe(realpathSync(first.cwd));
    expect(ranB).toMatchObject({ panel: 'panel-b' });
  });

  it("names a client that didn't name itself on the request after the tab's agent, so notify keeps its long wait", async () => {
    const ran = await ranAs(await callRepos(grantOf(start().grant(tab('panel-a')))));
    expect(ran).toMatchObject({ agent: 'Claude', returnAfter: null });
  });

  it('refuses a request without a token, with a made-up token, and after the tab closes', async () => {
    const grant = grantOf(start().grant(tab('panel-a')));

    expect((await callRepos(grant, { token: '' })).status).toBe(401);
    expect((await callRepos(grant, { token: 'not-a-pane-token' })).status).toBe(401);
    listener.forget('panel-a');
    const refused = await callRepos(grant);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: 'PANE_MCP_TOKEN_INVALID', next: expect.any(String) });
  });

  it('gives a restarted tab a new token and retires the old one', async () => {
    const server = start();
    const old = grantOf(server.grant(tab('panel-a')));
    const fresh = grantOf(server.grant(tab('panel-a')));

    expect((await callRepos(old)).status).toBe(401);
    expect((await callRepos(fresh)).status).toBe(200);
  });

  it('answers loopback only: a page that rebinds its own host name to 127.0.0.1 is refused', async () => {
    const grant = grantOf(start().grant(tab('panel-a')));

    expect(await statusWithHost(grant, 'attacker.example')).toBe(403);
    expect(await statusWithHost(grant, new URL(grant.url).host)).toBe(200);
    expect((await callRepos(grant, { headers: { origin: 'https://attacker.example' } })).status).toBe(403);
  });

  it.each([['2025-era', false], ['2026-07-28', true]])('ends the runpane process when a %s client drops the call', async (_revision, modern) => {
    const pidFile = path.join(appDir, `held-${String(modern)}.pid`);
    rmSync(pidFile, { force: true });
    const grant = grantOf(start().grant(tab('panel-a', { FAKE_HOLD: pidFile })));
    const abort = new AbortController();
    const call = callRepos(grant, { signal: abort.signal, modern }).catch(() => undefined);

    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 'the tool call to start');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    abort.abort();
    await call;
    await until(() => !alive(pid), 'the runpane process to end');
  });

  it("keeps new tabs on stdio once Pane's MCP tools fail to load", async () => {
    endpoint = new PaneMcpEndpoint({
      load: () => Promise.reject(new Error('mcp-http.cjs is missing')),
      cli: () => ({ executable: process.execPath, script: fakeCli }),
      settings: () => ({ enabled: true }),
      listener,
    });
    endpoint.attach();
    const grant = grantOf(endpoint.grant(tab('panel-a')));

    const failed = await callRepos(grant);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'PANE_MCP_UNAVAILABLE' });
    expect(endpoint.grant(tab('panel-b'))).toBeUndefined();
  });

  it('grants nothing while Pane tools are off, and refuses a running tab once they are turned off', async () => {
    const server = start();
    const grant = grantOf(server.grant(tab('panel-a')));
    enabled = false;

    expect(server.grant(tab('panel-b'))).toBeUndefined();
    const refused = await callRepos(grant);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'PANE_MCP_DISABLED' });
  });
});

describe('withPaneMcpConfig', () => {
  const words = (command: string) => tokenizeShellCommand(command, process.platform) ?? [];

  it("points a tab's agent at the endpoint only while the tab holds a token, and keeps its prompt argument", () => {
    const server = start();
    const command = "claude --model opus 'fix the login bug'";
    expect(withPaneMcpConfig('panel-a', 'claude', command, 'zsh')).toBe(command);

    server.grant(tab('panel-a'));
    const launched = words(withPaneMcpConfig('panel-a', 'claude', command, 'zsh'));
    const file = path.join(appDir, 'mcp', 'pane-http.json');

    expect(launched[0]).toBe('claude');
    expect(launched[1]).toBe(`--mcp-config=${file}`);
    expect(launched.at(-1)).toBe('fix the login bug');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      mcpServers: { pane: { type: 'http', url: '${PANE_MCP_URL}', headers: { Authorization: 'Bearer ${PANE_MCP_TOKEN}' } } },
    });
  });

  it("hides the Claude plugin's own pane server in a tab that reaches Pane over HTTP", () => {
    start().grant(tab('panel-a'));
    const launched = words(withPaneMcpConfig('panel-a', 'claude', "claude 'fix the login bug'", 'zsh'));
    const settings = launched.filter(word => word.startsWith('--settings'));

    expect(settings).toEqual([`--settings=${path.join(appDir, 'mcp', 'pane-http-settings.json')}`]);
    expect(JSON.parse(readFileSync(settings[0].slice('--settings='.length), 'utf8'))).toEqual({ deniedMcpServers: [{ serverName: 'plugin:pane:pane' }] });
    expect(launched.at(-1)).toBe('fix the login bug');
  });

  it('adds the plugin deny to settings JSON the command already passes, since Claude keeps only the last --settings', () => {
    start().grant(tab('panel-a'));
    const sessionFolder = { permissions: { additionalDirectories: ['/s'], deny: ['Edit(//s/**)'] } };
    for (const form of [`--settings '${JSON.stringify(sessionFolder)}'`, `'--settings=${JSON.stringify(sessionFolder)}'`]) {
      const launched = words(withPaneMcpConfig('panel-a', 'claude', `claude 'fix it' ${form}`, 'zsh'));
      const at = launched.findIndex(word => word.startsWith('--settings'));
      const value = launched[at] === '--settings' ? launched[at + 1] : launched[at].slice('--settings='.length);

      expect(launched.filter(word => word.startsWith('--settings'))).toHaveLength(1);
      expect(JSON.parse(value)).toEqual({ ...sessionFolder, deniedMcpServers: [{ serverName: 'plugin:pane:pane' }] });
      expect(launched).toContain('fix it');
    }
  });

  it('leaves wrappers, agents without the flag, and commands that keep MCP servers out unchanged', () => {
    start().grant(tab('panel-a'));
    for (const [agent, command] of [['claude', 'npx some-wrapper claude'], ['codex', 'codex --yolo'], ['claude', 'claude --strict-mcp-config']]) {
      expect(withPaneMcpConfig('panel-a', agent, command, 'zsh')).toBe(command);
    }
  });
});

process.on('exit', () => rmSync(appDir, { recursive: true, force: true }));
