#!/usr/bin/env node
// Behavior tests for `runpane mcp`: tool generation from the contract and
// stdio round-trips to a stubbed Pane daemon. Run after `pnpm --filter runpane build`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const rootDir = path.resolve(__dirname, '..');
const runpaneDir = path.join(rootDir, 'packages', 'runpane');
const dist = (file) => path.join(runpaneDir, 'dist', file);
const sdk = (subpath) => require(require.resolve(`@modelcontextprotocol/sdk/${subpath}`, { paths: [runpaneDir] }));
const { Client } = sdk('client/index.js');
const { StdioClientTransport } = sdk('client/stdio.js');

async function withMcpClient(action) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [dist('cli.js'), 'mcp'],
    env: { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'runpane-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await action(client);
  } finally {
    await client.close();
  }
}

/** Sends raw JSON-RPC lines to `runpane mcp`, closes stdin, and returns every stdout line plus the exit code. */
async function exchangeRaw(messages) {
  const child = spawn(process.execPath, [dist('cli.js'), 'mcp'], {
    env: { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1' },
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  const responses = new Map();
  const pending = messages.filter((message) => message.id !== undefined).length;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out; stdout so far:\n${stdout}`)), 20_000);
    child.stdout.on('data', () => {
      for (const line of stdout.split('\n').slice(0, -1).filter(Boolean)) {
        const message = JSON.parse(line);
        if (message.id !== undefined) responses.set(message.id, message);
      }
      if (responses.size >= pending) { clearTimeout(timer); resolve(); }
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.stdin.end();
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('still running'), 5_000))]);
  if (code === 'still running') child.kill();
  return { lines: stdout.split('\n').filter(Boolean), responses, code };
}

/** A stub result that never answers, to hold a tool call open. */
const HOLD = Symbol('hold');

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'runpane-mcp-test', version: '1.0.0' },
};

async function withStubDaemon(paneDir, results, action) {
  const { getPaneDaemonEndpoint } = require(dist('daemonClient.js'));
  const endpoint = getPaneDaemonEndpoint(paneDir);
  if (endpoint.transport === 'unix') {
    fs.mkdirSync(path.dirname(endpoint.path), { recursive: true });
    fs.rmSync(endpoint.path, { force: true });
  }
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const frame = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (frame.type !== 'request') continue;
        requests.push({ channel: frame.channel, args: frame.args, socket });
        if (results[frame.channel] === HOLD) continue;
        socket.write(`${JSON.stringify({ type: 'response', id: frame.id, ok: true, result: results[frame.channel] })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint.path, resolve);
  });
  try {
    return await action(requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (endpoint.transport === 'unix') fs.rmSync(path.dirname(endpoint.path), { recursive: true, force: true });
  }
}

test('a new contract command becomes a tool with inputs from its usage and agent context', () => {
  const { buildMcpTools, buildToolArgv } = require(dist('mcpTools.js'));
  const contract = {
    commands: [
      { name: 'help', summary: 'Show help.', usage: ['runpane help [command]'] },
      {
        name: 'widgets frob',
        summary: 'Frob a widget.',
        usage: ['runpane widgets frob --widget <widget-id> [--force] [--limit <count>] --yes [--json]'],
        mutates: true,
        jsonSchemas: ['widgetRequest', 'widgetResult'],
      },
    ],
    jsonSchemas: {
      widget: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      widgetRequest: { type: 'object', properties: { id: { type: 'string' } } },
      widgetResult: {
        type: 'object',
        properties: { ok: { const: true }, widget: { $ref: '#/jsonSchemas/widget' } },
        required: ['ok', 'widget'],
      },
    },
    flags: { localValue: [{ name: '--limit', value: '<count>', description: 'Maximum records.' }] },
    agentContext: {
      commands: {
        'widgets frob': {
          details: 'Use this to frob.',
          notes: ['Frobbing is permanent.'],
          arguments: [
            { name: '--widget', value: '<widget-id>', required: true, description: 'Widget id.' },
            { name: '--dry-run', required: false, description: 'Preview only.' },
          ],
        },
      },
    },
  };

  const tools = buildMcpTools(contract);

  assert.deepEqual(tools.map((tool) => tool.name), ['widgets_frob']);
  const [tool] = tools;
  assert.deepEqual(tool.annotations, {
    title: 'runpane widgets frob',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(tool.outputSchema, {
    type: 'object',
    properties: {
      ok: { const: true },
      widget: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    required: ['ok', 'widget'],
  });
  assert.match(tool.description, /Frob a widget\.\nUse this to frob\.\nFrobbing is permanent\./);
  assert.deepEqual(tool.inputSchema.required, ['widget']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(tool.inputSchema.properties).map(([key, value]) => [key, value.type])),
    { widget: 'string', force: 'boolean', limit: 'string', yes: 'boolean', dryRun: 'boolean' },
  );
  assert.deepEqual(
    buildToolArgv(tool, { widget: '- w1', limit: 5, force: true, dryRun: false, yes: true }),
    ['widgets', 'frob', '--widget=- w1', '--force', '--limit=5', '--yes', '--json'],
  );
  assert.throws(() => buildToolArgv(tool, { widget: 'w1', color: 'red' }), /Unknown argument\(s\) for widgets_frob: color/);
});

test('the server lists daemon and diagnostic commands but not installer commands', async () => {
  const tools = await withMcpClient(async (client) => (await client.listTools()).tools);
  const names = tools.map((tool) => tool.name);

  for (const expected of ['doctor', 'agent_context', 'repos_list', 'repos_add', 'panes_create', 'panels_submit_composer', 'watch']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  for (const excluded of ['help', 'setup', 'install', 'update', 'version', 'mcp']) {
    assert.ok(!names.includes(excluded), `unexpected tool ${excluded}`);
  }
  const reposList = tools.find((tool) => tool.name === 'repos_list');
  assert.equal(reposList.annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'repos_add').annotations.readOnlyHint, false);
  const watch = tools.find((tool) => tool.name === 'watch');
  assert.ok(!('follow' in watch.inputSchema.properties), 'watch must not offer --follow over MCP');
});

test('a tool call returns the CLI JSON from the daemon', async () => {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-mcp-'));
  const repos = [{ id: 7, name: 'demo', path: '/work/demo', active: true, environment: 'linux', sessionCount: 2 }];
  try {
    await withStubDaemon(paneDir, { 'runpane:repos:list': { ok: true, repos } }, async (requests) => {
      const result = await withMcpClient((client) => client.callTool({ name: 'repos_list', arguments: { paneDir } }));

      assert.notEqual(result.isError, true, result.content[0].text);
      assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, repos });
      assert.deepEqual(result.structuredContent, { ok: true, repos });
      assert.deepEqual(requests.map((request) => request.channel), ['runpane:repos:list']);
    });
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
});

test('a mutating call without yes is refused before reaching the daemon', async () => {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-mcp-'));
  try {
    await withStubDaemon(paneDir, {}, async (requests) => {
      const result = await withMcpClient((client) => client.callTool({
        name: 'panes_rename',
        arguments: { pane: 'pane-1', name: 'renamed', paneDir },
      }));

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /--yes/);
      assert.deepEqual(requests, []);
    });
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
});

test('conforms to MCP 2026-07-28 on the wire: discovery, tool shapes, errors, only JSON-RPC on stdout, clean exit', async () => {
  const { lines, responses, code } = await exchangeRaw([
    { id: 1, method: 'server/discover', params: { _meta: MODERN_META } },
    { id: 2, method: 'tools/list', params: { _meta: MODERN_META } },
    { id: 3, method: 'tools/call', params: { name: 'no_such_tool', arguments: {}, _meta: MODERN_META } },
    { id: 4, method: 'tools/call', params: { name: 'repos_list', arguments: { bogus: true }, _meta: MODERN_META } },
  ]);

  for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, '2.0', `stdout carried a non-JSON-RPC line: ${line}`);
  assert.equal(code, 0, 'the server should exit cleanly when stdin closes');

  const discover = responses.get(1).result;
  assert.ok(discover.supportedVersions.includes('2026-07-28'));
  assert.deepEqual(Object.keys(discover.capabilities), ['tools']);
  assert.equal(discover._meta['io.modelcontextprotocol/serverInfo'].name, 'pane');
  assert.ok(discover.instructions.length > 0);

  const list = responses.get(2).result;
  assert.equal(list.resultType, 'complete');
  assert.ok(Number.isInteger(list.ttlMs) && list.ttlMs >= 0);
  assert.ok(['public', 'private'].includes(list.cacheScope));
  const names = list.tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');
  for (const tool of list.tools) {
    assert.match(tool.name, /^[A-Za-z0-9_.-]{1,128}$/);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} inputSchema`);
    assert.equal(tool.outputSchema.type, 'object', `${tool.name} outputSchema`);
    assert.ok(tool.title && tool.description, `${tool.name} needs a title and description`);
    const { readOnlyHint, destructiveHint } = tool.annotations;
    assert.ok(!(readOnlyHint && destructiveHint), `${tool.name} cannot be read-only and destructive`);
  }
  const annotationsOf = (name) => list.tools.find((tool) => tool.name === name).annotations;
  assert.equal(annotationsOf('repos_list').readOnlyHint, true);
  assert.equal(annotationsOf('panes_archive').destructiveHint, true);
  assert.equal(annotationsOf('panes_create').destructiveHint, false);

  assert.equal(responses.get(3).error.code, -32602, 'an unknown tool is an Invalid Params protocol error');
  assert.equal(responses.get(4).result.isError, true, 'bad arguments are a tool execution error');
  assert.match(responses.get(4).result.content[0].text, /bogus/);
});

test('serves clients that still use the 2025 initialize handshake', async () => {
  const { responses, code } = await exchangeRaw([
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list', params: {} },
  ]);

  const init = responses.get(1).result;
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal(init.serverInfo.name, 'pane');
  assert.ok(responses.get(2).result.tools.length > 0);
  assert.equal(code, 0);
});

test('a failing command returns isError with the CLI message', async () => {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-mcp-'));
  try {
    const result = await withMcpClient((client) => client.callTool({ name: 'panels_screen', arguments: { panel: 'p1', paneDir } }));

    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.length > 0);
    assert.equal(result.structuredContent, undefined);
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
});

test('cancelling a call stops its runpane process', async () => {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-mcp-'));
  try {
    await withStubDaemon(paneDir, { 'runpane:repos:list': HOLD }, async (requests) => {
      await withMcpClient(async (client) => {
        const controller = new AbortController();
        const call = client.callTool({ name: 'repos_list', arguments: { paneDir } }, undefined, { signal: controller.signal });
        while (requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
        const disconnected = new Promise((resolve) => requests[0].socket.once('close', resolve));
        controller.abort();
        await assert.rejects(call);
        await Promise.race([
          disconnected,
          new Promise((_, reject) => setTimeout(() => reject(new Error('the runpane process kept its daemon connection open')), 5_000)),
        ]);
      });
    });
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
});
