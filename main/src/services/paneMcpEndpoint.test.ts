import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneMcpEndpoint, revokePaneMcp, setPaneMcpEndpoint, withPaneMcpConfig, type PaneMcpGrant } from './paneMcpEndpoint';

const appDir = mkdtempSync(path.join(os.tmpdir(), 'pane-mcp-endpoint-'));

/** A stand-in runpane CLI: prints, as `--json` output, who ran it and with what. */
const fakeCli = path.join(appDir, 'fake-runpane.js');
writeFileSync(fakeCli, 'process.stdout.write(JSON.stringify({ panel: process.env.PANE_PANEL_ID, cwd: process.cwd(), argv: process.argv.slice(2) }));\n');

const callResult = boundary.object({
  result: boundary.object({ structuredContent: boundary.object({ panel: boundary.string, cwd: boundary.string, argv: boundary.array(boundary.string) }) }),
});

let endpoint: PaneMcpEndpoint | undefined;
beforeEach(() => { vi.stubEnv('PANE_DIR', appDir); });
afterEach(async () => {
  vi.unstubAllEnvs();
  setPaneMcpEndpoint(undefined);
  await endpoint?.stop();
  endpoint = undefined;
});

async function start(settings = { enabled: true }) {
  endpoint = new PaneMcpEndpoint({
    load: () => import('../../../packages/runpane/src/mcpHttp'),
    cli: () => ({ executable: process.execPath, script: fakeCli }),
    settings: () => settings,
  });
  await endpoint.start();
  setPaneMcpEndpoint(endpoint);
  return endpoint;
}

function tab(panelId: string) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), `pane-mcp-${panelId}-`));
  return { panelId, cwd, env: { PATH: process.env.PATH ?? '', PANE_PANEL_ID: panelId } };
}

/** One tools/call as an MCP client sends it over streamable HTTP. */
function callRepos(grant: PaneMcpGrant, init: { token?: string; headers?: Record<string, string> } = {}) {
  return fetch(grant.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${init.token ?? grant.token}`,
      ...init.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'repos_list', arguments: {} } }),
  });
}

/** fetch never sends a Host header of its own choosing, so this one request goes through node:http. */
function statusWithHost(grant: PaneMcpGrant, host: string): Promise<number | undefined> {
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
  return decodeBoundary(JSON.parse(data ? data.slice('data: '.length) : text), callResult).result.structuredContent;
}

describe('PaneMcpEndpoint', () => {
  it('runs a tool as the tab its token belongs to, in that tab\'s folder', async () => {
    const server = await start();
    const first = tab('panel-a');
    const second = tab('panel-b');
    const grantA = server.grant(first)!;
    const grantB = server.grant(second)!;

    const ranA = await ranAs(await callRepos(grantA));
    const ranB = await ranAs(await callRepos(grantB));

    expect(ranA).toMatchObject({ panel: 'panel-a', argv: ['repos', 'list', '--json'] });
    expect(ranA.cwd).toBe(realpathSync(first.cwd));
    expect(ranB).toMatchObject({ panel: 'panel-b' });
  });

  it('refuses a request without a token, with a made-up token, and after the tab closes', async () => {
    const server = await start();
    const grant = server.grant(tab('panel-a'))!;

    expect((await callRepos(grant, { token: '' })).status).toBe(401);
    expect((await callRepos(grant, { token: 'not-a-pane-token' })).status).toBe(401);
    revokePaneMcp('panel-a');
    expect((await callRepos(grant)).status).toBe(401);
  });

  it('gives a restarted tab a new token and retires the old one', async () => {
    const server = await start();
    const old = server.grant(tab('panel-a'))!;
    const fresh = server.grant(tab('panel-a'))!;

    expect((await callRepos(old)).status).toBe(401);
    expect((await callRepos(fresh)).status).toBe(200);
  });

  it('answers loopback only: a page that rebinds its own host name to 127.0.0.1 is refused', async () => {
    const server = await start();
    const grant = server.grant(tab('panel-a'))!;

    expect(await statusWithHost(grant, 'attacker.example')).toBe(403);
    expect(await statusWithHost(grant, new URL(grant.url).host)).toBe(200);
    expect((await callRepos(grant, { headers: { origin: 'https://attacker.example' } })).status).toBe(403);
  });

  it('grants nothing while Pane tools are turned off, so agents keep stdio', async () => {
    const server = await start({ enabled: false });
    expect(server.grant(tab('panel-a'))).toBeUndefined();
  });
});

describe('withPaneMcpConfig', () => {
  it('points a Claude launch at the endpoint and keeps its prompt argument', async () => {
    await start();
    const command = withPaneMcpConfig("claude --model opus 'fix the login bug'", 'zsh');
    const file = path.join(appDir, 'mcp', 'claude-http.json');

    expect(command).toBe(`claude '--mcp-config=${file}' --model opus 'fix the login bug'`);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      mcpServers: { pane: { type: 'http', url: '${PANE_MCP_URL}', headers: { Authorization: 'Bearer ${PANE_MCP_TOKEN}' } } },
    });
    expect(withPaneMcpConfig(command, 'zsh')).toBe(command);
  });

  it('leaves other commands, and every command while the endpoint is down, unchanged', async () => {
    expect(withPaneMcpConfig('claude', 'zsh')).toBe('claude');
    await start();
    expect(withPaneMcpConfig('npx some-wrapper claude', 'zsh')).toBe('npx some-wrapper claude');
  });
});

process.on('exit', () => rmSync(appDir, { recursive: true, force: true }));
