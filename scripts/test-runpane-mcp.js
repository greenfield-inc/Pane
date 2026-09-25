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

async function withMcpClient(action, { args = ['--toolsets', 'all'], env = {} } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [dist('cli.js'), 'mcp', ...args],
    env: { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1', ...env },
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
        const answer = results[frame.channel];
        if (answer === HOLD) continue;
        const result = answer instanceof Function ? answer(frame.args) : answer;
        socket.write(`${JSON.stringify({ type: 'response', id: frame.id, ok: true, result })}\n`);
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
  assert.deepEqual(Object.keys(discover.capabilities).sort(), ['resources', 'tools']);
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
  assert.equal(annotationsOf('agents_start').destructiveHint, false);

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

test('serves the core toolset by default, and named toolsets or read-only on request', async () => {
  const names = (args) => withMcpClient(async (client) => (await client.listTools()).tools, { args });

  const core = await names([]);
  assert.deepEqual(core.map((tool) => tool.name).sort(), [
    'agents_send', 'agents_start', 'agents_status', 'docs_read', 'docs_search', 'doctor', 'links_create',
    'panes_archive', 'panes_git_status', 'panes_list', 'panes_restore', 'repos_add', 'repos_list', 'workspace_state',
  ]);
  const git = await names(['--toolsets', 'git']);
  assert.deepEqual(git.map((tool) => tool.name).sort(), ['panes_commit', 'panes_git_status', 'panes_pull', 'panes_push', 'panes_rebase_main']);
  const readOnly = await names(['--toolsets', 'all', '--read-only']);
  assert.ok(readOnly.length > 0 && readOnly.every((tool) => tool.annotations.readOnlyHint));
  assert.ok(!readOnly.some((tool) => tool.name === 'panes_archive'));
});

test('an unknown toolset stops the server with the valid names', () => {
  const result = require('node:child_process').spawnSync(process.execPath, [dist('cli.js'), 'mcp', '--toolsets', 'everything'], {
    encoding: 'utf8', input: '', env: { ...process.env, RUNPANE_TELEMETRY_DISABLED: '1' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown toolset\(s\): everything\. Choose from: .*core.*git/);
});

test('a tool outside the served toolsets says which toolset has it', async () => {
  const { responses } = await exchangeRaw([
    { id: 1, method: 'tools/call', params: { name: 'panes_push', arguments: {}, _meta: MODERN_META } },
  ]);
  assert.equal(responses.get(1).error.code, -32602);
  assert.match(responses.get(1).error.message, /"git" toolset/);
});

test('docs search finds docs, help, and installed skills; docs read and resources return the full text', async () => {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-mcp-'));
  const skillDir = path.join(paneDir, 'skills', 'pane-chat', 'skills', 'zebra-release');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: zebra-release\ndescription: "Ship a zebra release"\n---\n\nRun the zebrafication checklist before tagging.\n');
  try {
    await withMcpClient(async (client) => {
      const skill = (await client.callTool({ name: 'docs_search', arguments: { query: 'zebrafication checklist' } })).structuredContent;
      assert.equal(skill.results[0].path, 'skills/zebra-release/SKILL.md');
      assert.equal(skill.results[0].kind, 'skill');
      assert.match(skill.results[0].excerpt, /zebrafication checklist/);

      const doc = (await client.callTool({ name: 'docs_search', arguments: { query: 'pane mcp toolsets', limit: 3 } })).structuredContent;
      assert.ok(doc.results.some((result) => result.path === 'docs/PANE_MCP.md'), JSON.stringify(doc.results));

      const read = (await client.callTool({ name: 'docs_read', arguments: { doc: 'docs/PANE_MCP.md' } })).structuredContent;
      assert.match(read.text, /^# Pane MCP Server/);
      const missing = await client.callTool({ name: 'docs_read', arguments: { doc: 'docs/NOPE.md' } });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0].text, /docs search/);

      const { resources } = await client.listResources();
      const resource = resources.find((entry) => entry.name === 'docs/PANE_MCP.md');
      const contents = await client.readResource({ uri: resource.uri });
      assert.match(contents.contents[0].text, /^# Pane MCP Server/);
    }, { args: [], env: { PANE_DIR: paneDir } });
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
});

test('links_create returns a pane:// link and explains bad ids', async () => {
  await withMcpClient(async (client) => {
    const link = await client.callTool({ name: 'links_create', arguments: { pane: 'pane-1', panel: 'panel-2' } });
    assert.deepEqual(link.structuredContent, {
      ok: true, url: 'pane://open?pane=pane-1&panel=panel-2', target: { kind: 'pane', id: 'pane-1', panelId: 'panel-2' },
    });
    const bad = await client.callTool({ name: 'links_create', arguments: { repo: 'Pane' } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /`repos_list`/);
  }, { args: [] });
});

test('parity tools call the app daemon channel with the pane id and keep the --yes rule', async () => {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-mcp-'));
  try {
    await withStubDaemon(paneDir, {
      'sessions:get-git-status': { success: true, gitStatus: { state: 'ahead', ahead: 2 } },
      'sessions:git-push': { success: false, error: 'No upstream branch' },
    }, async (requests) => {
      await withMcpClient(async (client) => {
        const status = await client.callTool({ name: 'panes_git_status', arguments: { pane: 'pane-1', paneDir } });
        assert.deepEqual(status.structuredContent, { ok: true, data: { gitStatus: { state: 'ahead', ahead: 2 } } });

        const refused = await client.callTool({ name: 'panes_push', arguments: { pane: 'pane-1', paneDir } });
        assert.equal(refused.isError, true);
        const failed = await client.callTool({ name: 'panes_push', arguments: { pane: 'pane-1', paneDir, yes: true } });
        assert.equal(failed.isError, true);
        assert.match(failed.content[0].text, /No upstream branch/);
      });
      assert.deepEqual(requests.map(({ channel, args }) => ({ channel, args })), [
        { channel: 'sessions:get-git-status', args: ['pane-1'] },
        { channel: 'sessions:git-push', args: ['pane-1'] },
      ]);
    });
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
});

test('agent tasks start, check on, and message an agent in one call each', async () => {
  const paneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-mcp-'));
  const repo = { id: 3, name: 'app', path: '/work/app', active: true, environment: 'linux', sessionCount: 1 };
  try {
    await withStubDaemon(paneDir, {
      'runpane:panes:create': {
        ok: true, repo,
        items: [{
          ok: true, index: 0, name: 'fix-login', pinned: true, sessionId: 'pane-7', panelId: 'panel-8', worktreePath: '/work/app-fix-login',
          readiness: { ok: true, condition: 'ready', matched: true, timedOut: false, elapsedMs: 900, state: { initialized: true } },
          initialInput: { delivered: true, submitted: true, inputBytes: 17 },
        }],
      },
      'runpane:panels:list': { ok: true, paneId: 'pane-7', panels: [
        { id: 'panel-shell', panelId: 'panel-shell', paneId: 'pane-7', type: 'terminal', title: 'Terminal', active: false },
        { id: 'panel-8', panelId: 'panel-8', paneId: 'pane-7', type: 'terminal', title: 'Claude', active: true, isCliPanel: true, agentType: 'claude' },
      ] },
      'runpane:workspace:state': { ok: true, epoch: 'epoch-1', generation: 4, entries: [
        { gen: 4, at: '2026-09-25T00:00:00.000Z', kind: 'agent.blocked', paneId: 'pane-7', paneName: 'fix-login', panelId: 'panel-8', source: 'agent', baseline: true },
      ] },
      'runpane:panels:screen': (args) => ({
        ok: true, panelId: args[0].panelId, paneId: 'pane-7', source: 'scrollback', limit: args[0].limit, returnedLineCount: 1, hasMore: false,
        text: 'Allow edits to login.ts? (y/n)', state: { initialized: true }, composer: { isPresent: true, hasUndeliveredText: false },
      }),
      'runpane:panels:submit': (args) => ({
        ok: true, panelId: args[0].panelId, paneId: 'pane-7', inputBytes: 1, enter: 'cr', sequenceName: 'enter-cr', verifiedSubmitted: true, sentAt: '2026-09-25T00:00:01.000Z',
      }),
    }, async (requests) => {
      await withMcpClient(async (client) => {
        const started = await client.callTool({ name: 'agents_start', arguments: {
          repo: 'app', name: 'fix-login', agent: 'claude', prompt: 'Fix the login redirect', yes: true, paneDir,
        } });
        assert.equal(started.isError, undefined, started.content[0].text);
        assert.equal(started.structuredContent.link, 'pane://open?pane=pane-7&panel=panel-8');
        assert.equal(started.structuredContent.ready, true);

        const status = await client.callTool({ name: 'agents_status', arguments: { pane: 'pane-7', paneDir } });
        assert.equal(status.isError, undefined, status.content[0].text);
        assert.equal(status.structuredContent.status, 'blocked');
        assert.equal(status.structuredContent.panelId, 'panel-8');
        assert.match(status.structuredContent.screen, /Allow edits/);

        const sent = await client.callTool({ name: 'agents_send', arguments: { pane: 'pane-7', text: 'y', yes: true, paneDir } });
        assert.equal(sent.structuredContent.delivered, true);
        assert.match(sent.structuredContent.next, /`agents_status` with pane: pane-7/);
      }, { args: [] });
      const create = requests.find((request) => request.channel === 'runpane:panes:create').args[0];
      assert.equal(create.source, 'agent');
      assert.equal(create.waitReady, true);
      assert.equal(create.noFocus, true);
      assert.deepEqual(requests.find((request) => request.channel === 'runpane:panels:submit').args[0], { panelId: 'panel-8', input: 'y' });
    });
  } finally {
    fs.rmSync(paneDir, { recursive: true, force: true });
  }
});
