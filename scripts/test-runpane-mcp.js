#!/usr/bin/env node
// Behavior tests for `runpane mcp`: tool generation from the contract and
// stdio round-trips to a stubbed Pane daemon. Run after `pnpm --filter runpane build`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
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
        requests.push({ channel: frame.channel, args: frame.args });
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
        jsonSchemas: ['widgetResult'],
      },
    ],
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
  assert.equal(tool.mutates, true);
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
